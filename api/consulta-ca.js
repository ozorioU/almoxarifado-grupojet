// Funcao serverless (Vercel) que consulta a validade de um CA de EPI.
//
// Descoberta importante: tanto o site do governo (caepi.trabalho.gov.br) quanto o
// consultaca.com bloqueiam requisicoes vindas de IPs de provedores de nuvem (Vercel, AWS, etc).
// Por isso, a estrategia principal usa o ScraperAPI (servico com IPs residenciais) para
// contornar esse bloqueio. Se a chave SCRAPER_API_KEY nao estiver configurada, cai
// automaticamente para tentativas diretas (que tendem a falhar, mas nao custam nada).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function limparTextoHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairCaEValidade(texto) {
  const situacaoMatch = texto.match(/Situa[çc][ãa]o:?\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,})/);
  const validadeMatch = texto.match(/Validade:?\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!situacaoMatch && !validadeMatch) return null;
  return {
    DataValidade: validadeMatch ? validadeMatch[1] : null,
    Situacao: situacaoMatch ? situacaoMatch[1].trim() : null
  };
}

function montarUrlScraperApi(targetUrl, render) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) return null;
  let url = 'http://api.scraperapi.com/?api_key=' + apiKey + '&url=' + encodeURIComponent(targetUrl);
  if (render) url += '&render=true';
  return url;
}

// Tentativa 1: consultaca.com via ScraperAPI (com renderizacao, pois o site usa Cloudflare/JS challenge)
async function viaScraperApiConsultaCA(numeroLimpo) {
  const url = montarUrlScraperApi('https://consultaca.com/' + numeroLimpo, true);
  if (!url) return { ok: false, motivo: 'sem_chave_scraperapi' };

  const resp = await fetch(url, { signal: AbortSignal.timeout(28000) });
  if (!resp.ok) return { ok: false, status: resp.status };
  const html = await resp.text();
  const texto = limparTextoHtml(html);
  const dados = extrairCaEValidade(texto);
  if (!dados) return { ok: false, amostra: texto.slice(0, 300) };

  let nomeEquipamento = null;
  const tituloMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (tituloMatch) {
    nomeEquipamento = tituloMatch[1].replace(/&amp;/gi, '&').replace(new RegExp('^CA\\s*' + numeroLimpo + '\\s*-\\s*', 'i'), '').trim();
  }
  dados.NomeEquipamento = nomeEquipamento;
  dados.Fonte = 'consultaca.com (via ScraperAPI)';
  return { ok: true, dados };
}

// Tentativa 2 (mais rapida, sem render): site do governo via ScraperAPI
function extrairValorCampo(html, id) {
  const re = new RegExp('id="' + id + '"[^>]*value="([^"]*)"');
  const m = html.match(re);
  return m ? m[1] : '';
}
async function viaScraperApiGoverno(numeroLimpo) {
  const baseUrl = 'https://caepi.trabalho.gov.br/internet/consultacainternet.aspx';
  const getUrl = montarUrlScraperApi(baseUrl, false);
  if (!getUrl) return { ok: false, motivo: 'sem_chave_scraperapi' };

  const getResp = await fetch(getUrl, { signal: AbortSignal.timeout(20000) });
  if (!getResp.ok) return { ok: false, etapa: 'GET', status: getResp.status };
  const getHtml = await getResp.text();

  const viewState = extrairValorCampo(getHtml, '__VIEWSTATE');
  const viewStateGen = extrairValorCampo(getHtml, '__VIEWSTATEGENERATOR');
  const eventValidation = extrairValorCampo(getHtml, '__EVENTVALIDATION');
  const textboxMatch = getHtml.match(/name="(ctl00\$PlaceHolderConteudo\$[A-Za-z0-9_]*)"[^>]*type="text"/i);
  const campoTexto = textboxMatch ? textboxMatch[1] : null;
  const buttonMatch = getHtml.match(/name="(ctl00\$PlaceHolderConteudo\$[A-Za-z0-9_]*)"[^>]*value="Consultar"/i)
    || getHtml.match(/value="Consultar"[^>]*name="(ctl00\$PlaceHolderConteudo\$[A-Za-z0-9_]*)"/i);
  const campoBotao = buttonMatch ? buttonMatch[1] : null;

  if (!campoTexto || !campoBotao || !viewState) {
    return { ok: false, etapa: 'GET-parse', campoTexto, campoBotao, temViewState: !!viewState };
  }

  const params = new URLSearchParams();
  params.set('__VIEWSTATE', viewState);
  params.set('__VIEWSTATEGENERATOR', viewStateGen);
  params.set('__EVENTVALIDATION', eventValidation);
  params.set(campoTexto, numeroLimpo);
  params.set(campoBotao, 'Consultar');

  const postApiUrl = 'http://api.scraperapi.com/?api_key=' + process.env.SCRAPER_API_KEY + '&url=' + encodeURIComponent(baseUrl) + '&method=POST';
  const postResp = await fetch(postApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000)
  });
  if (!postResp.ok) return { ok: false, etapa: 'POST', status: postResp.status };
  const resultHtml = await postResp.text();
  const texto = limparTextoHtml(resultHtml);
  const dados = extrairCaEValidade(texto);
  if (!dados) return { ok: false, etapa: 'POST-parse', amostra: texto.slice(0, 300) };
  dados.NomeEquipamento = null;
  dados.Fonte = 'caepi.trabalho.gov.br (via ScraperAPI)';
  return { ok: true, dados };
}

// Tentativas diretas (sem ScraperAPI) - ficam como reserva, mas tendem a ser bloqueadas
async function tentativaDiretaConsultaCA(numeroLimpo) {
  const resp = await fetch('https://consultaca.com/' + numeroLimpo, {
    signal: AbortSignal.timeout(9000),
    headers: { 'User-Agent': UA }
  });
  const html = await resp.text();
  const texto = limparTextoHtml(html);
  if (!resp.ok) return { ok: false, status: resp.status };
  const dados = extrairCaEValidade(texto);
  if (!dados) return { ok: false, amostra: texto.slice(0, 300) };
  dados.Fonte = 'consultaca.com (direto)';
  return { ok: true, dados };
}

async function consultarApiComunidade(numeroLimpo) {
  const resp = await fetch('https://projeto-ca-api.rj.r.appspot.com/api/ca/' + numeroLimpo, { signal: AbortSignal.timeout(9000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || (!data.DataValidade && !data.Situacao)) return null;
  data.Fonte = 'appspot-fallback';
  return data;
}

module.exports = async function handler(req, res) {
  const numero = req.query.numero;
  const debug = req.query.debug === '1';

  if (!numero) return res.status(400).json({ error: 'Parametro "numero" e obrigatorio.' });
  const numeroLimpo = String(numero).replace(/\D/g, '');
  if (!numeroLimpo) return res.status(400).json({ error: 'Numero de CA invalido.' });

  const diagnosticos = {};
  const temScraperApi = !!process.env.SCRAPER_API_KEY;

  if (temScraperApi) {
    try {
      const r1 = await viaScraperApiGoverno(numeroLimpo);
      diagnosticos.governoScraperApi = r1;
      if (r1.ok) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return res.status(200).json(r1.dados);
      }
    } catch (e) {
      diagnosticos.governoScraperApi = { ok: false, excecao: String(e && e.message ? e.message : e) };
    }

    try {
      const r2 = await viaScraperApiConsultaCA(numeroLimpo);
      diagnosticos.consultaCaScraperApi = r2;
      if (r2.ok) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return res.status(200).json(r2.dados);
      }
    } catch (e) {
      diagnosticos.consultaCaScraperApi = { ok: false, excecao: String(e && e.message ? e.message : e) };
    }
  } else {
    diagnosticos.aviso = 'SCRAPER_API_KEY nao configurada nas variaveis de ambiente do Vercel — consultas diretas tendem a ser bloqueadas.';
  }

  try {
    const r3 = await tentativaDiretaConsultaCA(numeroLimpo);
    diagnosticos.direta = r3;
    if (r3.ok) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r3.dados);
    }
  } catch (e) {
    diagnosticos.direta = { ok: false, excecao: String(e && e.message ? e.message : e) };
  }

  try {
    const r4 = await consultarApiComunidade(numeroLimpo);
    if (r4) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r4);
    }
  } catch (e) {
    diagnosticos.appspot = { excecao: String(e && e.message ? e.message : e) };
  }

  const respostaErro = { error: 'Nao foi possivel encontrar dados para o CA ' + numeroLimpo + ' em nenhuma fonte disponivel.' };
  if (debug) respostaErro.diagnostico = diagnosticos;
  return res.status(404).json(respostaErro);
};
