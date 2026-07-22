// Funcao serverless (Vercel) que consulta a validade de um CA de EPI.
// Roda no servidor, entao nao sofre bloqueio de CORS do navegador.
//
// Fonte principal: consultaca.com (site ativo e mantido)
// Fonte reserva: projeto-ca-api.rj.r.appspot.com (projeto de comunidade, pode estar fora do ar)

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

async function consultarConsultaCA(numeroLimpo) {
  const resp = await fetch('https://consultaca.com/' + numeroLimpo, {
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    }
  });

  const html = await resp.text();
  const texto = limparTextoHtml(html);

  if (!resp.ok) {
    return { ok: false, status: resp.status, bloqueado: pareceBloqueioAntiRobo(texto), amostra: texto.slice(0, 300) };
  }

  const situacaoMatch = texto.match(/Situa[çc][ãa]o:?\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,})/);
  const validadeMatch = texto.match(/Validade:?\s*(\d{2}\/\d{2}\/\d{4})/);

  if (!situacaoMatch && !validadeMatch) {
    return { ok: false, status: resp.status, bloqueado: pareceBloqueioAntiRobo(texto), amostra: texto.slice(0, 300) };
  }

  let nomeEquipamento = null;
  const tituloMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (tituloMatch) {
    nomeEquipamento = tituloMatch[1]
      .replace(/&amp;/gi, '&')
      .replace(new RegExp('^CA\\s*' + numeroLimpo + '\\s*-\\s*', 'i'), '')
      .trim();
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
  const resp = await fetch('https://projeto-ca-api.rj.r.appspot.com/api/ca/' + numeroLimpo, {
    signal: AbortSignal.timeout(9000)
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || (!data.DataValidade && !data.Situacao)) return null;
  data.Fonte = 'appspot-fallback';
  return data;
}

module.exports = async function handler(req, res) {
  const numero = req.query.numero;
  const debug = req.query.debug === '1';

  if (!numero) {
    return res.status(400).json({ error: 'Parametro "numero" e obrigatorio.' });
  }

  const numeroLimpo = String(numero).replace(/\D/g, '');
  if (!numeroLimpo) {
    return res.status(400).json({ error: 'Numero de CA invalido.' });
  }

  let diagnosticoPrincipal = null;

  try {
    const resultado = await consultarConsultaCA(numeroLimpo);
    diagnosticoPrincipal = resultado;
    if (resultado.ok) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(resultado.dados);
    }
  } catch (e) {
    diagnosticoPrincipal = { ok: false, excecao: String(e && e.message ? e.message : e) };
  }

  try {
    const resultado2 = await consultarApiComunidade(numeroLimpo);
    if (resultado2) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json(resultado2);
    }
  } catch (e) {
    // nenhuma fonte funcionou
  }

  const respostaErro = { error: 'Nao foi possivel encontrar dados para o CA ' + numeroLimpo + ' em nenhuma fonte disponivel.' };
  if (debug) respostaErro.diagnostico = diagnosticoPrincipal;
  return res.status(404).json(respostaErro);
};
