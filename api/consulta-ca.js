// Funcao serverless (Vercel) que consulta a validade de um CA de EPI.
//
// Estrategia: consultaca.com bloqueia IPs de nuvem (Cloudflare), entao usamos o ScraperAPI
// (servico com IPs residenciais + renderizacao de JavaScript) para contornar isso.
// Se SCRAPER_API_KEY nao estiver configurada, cai para tentativas diretas (tendem a falhar).

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

async function viaScraperApiConsultaCA(numeroLimpo, timeoutMs) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) return { ok: false, motivo: 'sem_chave_scraperapi' };

  const targetUrl = 'https://consultaca.com/' + numeroLimpo;
  const scraperUrl = 'http://api.scraperapi.com/?api_key=' + apiKey + '&url=' + encodeURIComponent(targetUrl) + '&render=true';

  const resp = await fetch(scraperUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return { ok: false, status: resp.status };
  const html = await resp.text();
  const texto = limparTextoHtml(html);
  const dados = extrairCaEValidade(texto);
  if (!dados) return { ok: false, amostra: texto.slice(0, 300) };

  let nomeEquipamento = null;
  const tituloMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (tituloMatch) {
    nomeEquipamento = tituloMatch[1].trim().replace(/&amp;/gi, '&').replace(new RegExp('^CA\\s*' + numeroLimpo + '\\s*-\\s*', 'i'), '').trim();
  }
  dados.NomeEquipamento = nomeEquipamento;
  dados.Fonte = 'consultaca.com (via ScraperAPI)';
  return { ok: true, dados };
}

async function consultarApiComunidade(numeroLimpo) {
  const resp = await fetch('https://projeto-ca-api.rj.r.appspot.com/api/ca/' + numeroLimpo, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || (!data.DataValidade && !data.Situacao)) return null;
  data.Fonte = 'appspot-fallback';
  return data;
}

async function tentativaDiretaConsultaCA(numeroLimpo) {
  const resp = await fetch('https://consultaca.com/' + numeroLimpo, { signal: AbortSignal.timeout(6000) });
  const html = await resp.text();
  const texto = limparTextoHtml(html);
  if (!resp.ok) return { ok: false, status: resp.status };
  const dados = extrairCaEValidade(texto);
  if (!dados) return { ok: false };
  dados.Fonte = 'consultaca.com (direto)';
  return { ok: true, dados };
}

module.exports = async function handler(req, res) {
  const numero = req.query.numero;
  const debug = req.query.debug === '1';

  if (!numero) return res.status(400).json({ error: 'Parametro "numero" e obrigatorio.' });
  const numeroLimpo = String(numero).replace(/\D/g, '');
  if (!numeroLimpo) return res.status(400).json({ error: 'Numero de CA invalido.' });

  const diagnosticos = {};

  if (process.env.SCRAPER_API_KEY) {
    try {
      const r1 = await viaScraperApiConsultaCA(numeroLimpo, 45000);
      diagnosticos.consultaCaScraperApi = r1;
      if (r1.ok) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return res.status(200).json(r1.dados);
      }
    } catch (e) {
      diagnosticos.consultaCaScraperApi = { ok: false, excecao: String(e && e.message ? e.message : e) };
    }
  } else {
    diagnosticos.aviso = 'SCRAPER_API_KEY nao configurada.';
  }

  try {
    const r2 = await consultarApiComunidade(numeroLimpo);
    if (r2) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r2);
    }
  } catch (e) {
    diagnosticos.appspot = { excecao: String(e && e.message ? e.message : e) };
  }

  try {
    const r3 = await tentativaDiretaConsultaCA(numeroLimpo);
    diagnosticos.direta = r3;
    if (r3.ok) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(r3.dados);
    }
  } catch (e) {
    diagnosticos.direta = { excecao: String(e && e.message ? e.message : e) };
  }

  const respostaErro = { error: 'Nao foi possivel encontrar dados para o CA ' + numeroLimpo + ' em nenhuma fonte disponivel.' };
  if (debug) respostaErro.diagnostico = diagnosticos;
  return res.status(404).json(respostaErro);
};
