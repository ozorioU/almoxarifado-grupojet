// Funcao serverless (Vercel) que consulta a validade de um CA de EPI.
// Roda no servidor, entao nao sofre bloqueio de CORS do navegador.
//
// Fonte principal: caepi.trabalho.gov.br (sistema oficial do Ministerio do Trabalho, sem protecao anti-robo)
// Fonte reserva 1: consultaca.com (costuma bloquear robos via Cloudflare, mas tentamos mesmo assim)
// Fonte reserva 2: projeto-ca-api.rj.r.appspot.com (projeto de comunidade, pode estar fora do ar)

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

function pareceBloqueioAntiRobo(texto) {
  var marcas = ['cloudflare', 'checking your browser', 'just a moment', 'captcha', 'attention required', 'access denied', 'ray id'];
  var textoMin = texto.toLowerCase();
  return marcas.some(function(m) { return textoMin.includes(m); });
}

function extrairValorCampo(html, id) {
  const re = new RegExp('id="' + id + '"[^>]*value="([^"]*)"');
  const m = html.match(re);
  return m ? m[1] : '';
}

async function consultarGovCaepi(numeroLimpo) {
  const baseUrl = 'https://caepi.trabalho.gov.br/internet/consultacainternet.aspx';

  const getResp = await fetch(baseUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
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
    return { ok: false, etapa: 'GET-parse', campoTexto, campoBotao, temViewState: !!viewState, amostra: limparTextoHtml(getHtml).slice(0, 300) };
  }

  const params = new URLSearchParams();
  params.set('__VIEWSTATE', viewState);
  params.set('__VIEWSTATEGENERATOR', viewStateGen);
  params.set('__EVENTVALIDATION', eventValidation);
  params.set(campoTexto, numeroLimpo);
  params.set(campoBotao, 'Consultar');

  const postResp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA
    },
    body: params.toString(),
    signal: AbortSignal.timeout(9000)
  });
  if (!postResp.ok) return { ok: false, etapa: 'POST', status: postResp.status };
  const resultHtml = await postResp.text();
  const texto = limparTextoHtml(resultHtml);

  const situacaoMatch = texto.match(/Situa[çc][ãa]o:?\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,})/);
  const validadeMatch = texto.match(/Validade:?\s*(\d{2}\/\d{2}\/\d{4})/);

  if (!situacaoMatch && !validadeMatch) {
    return { ok: false, etapa: 'POST-parse', amostra: texto.slice(0, 400) };
  }

  return {
    ok: true,
    dados: {
      DataValidade: validadeMatch ? validadeMatch[1] : null,
      Situacao: situacaoMatch ? situacaoMatch[1].trim() : null,
      NomeEquipamento: null,
      Fonte: 'caepi.trabalho.gov.br'
    }
  };
}

async function consultarConsultaCA(numeroLimpo) {
  const resp = await fetch('https://consultaca.com/' + numeroLimpo, {
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    }
  });
  const html = await resp.text();
  const texto = limparTextoHtml(html);
  if (!resp.ok) return { ok: false, status: resp.status, bloqueado: pareceBloqueioAntiRobo(texto), amostra: texto.slice(0, 300) };

  const situacaoMatch = texto.match(/Situa[çc][ãa]o:?\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,})/);
  const validadeMatch = texto.match(/Validade:?\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!situacaoMatch && !validadeMatch) {
    return { ok: false, status: resp.status, bloqueado: pareceBloqueioAntiRobo(texto), amostra: texto.slice(0, 300) };
  }

  let nomeEquipamento = null;
  const tituloMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (tituloMatch) {
    nomeEquipamento = tituloMatch[1].replace(/&amp;/gi, '&').replace(new RegExp('^CA\\s*' + numeroLimpo + '\\s*-\\s*', 'i'), '').trim();
  }

  return {
    ok: true,
    dados: {
      DataValidade: validadeMatch ? validadeMatch[1] : null,
      Situacao: situacaoMatch ? situacaoMatch[1].trim() : null,
      NomeEquipamento: nomeEquipamento || null,
      Fonte: 'consultaca.com'
    }
  };
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

  try {
    const r1 = await consultarGovCaepi(numeroLimpo);
    diagnosticos.gov = r1;
    if (r1.ok) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r1.dados);
    }
  } catch (e) {
    diagnosticos.gov = { ok: false, excecao: String(e && e.message ? e.message : e) };
  }

  try {
    const r2 = await consultarConsultaCA(numeroLimpo);
    diagnosticos.consultaca = r2;
    if (r2.ok) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r2.dados);
    }
  } catch (e) {
    diagnosticos.consultaca = { ok: false, excecao: String(e && e.message ? e.message : e) };
  }

  try {
    const r3 = await consultarApiComunidade(numeroLimpo);
    if (r3) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r3);
    }
  } catch (e) {
    diagnosticos.appspot = { excecao: String(e && e.message ? e.message : e) };
  }

  const respostaErro = { error: 'Nao foi possivel encontrar dados para o CA ' + numeroLimpo + ' em nenhuma fonte disponivel.' };
  if (debug) respostaErro.diagnostico = diagnosticos;
  return res.status(404).json(respostaErro);
};
