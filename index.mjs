/**
 * extract-equatorialpdfjs-v1.0
 * Extração posicional (pdf.js) + fallback regex — Equatorial Goiás
 * Node 20.x | Express | pdfjs-dist  Ver 1.0  19/10 19:15
 */

import express from "express";
import multer from "multer";
import dayjs from "dayjs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// pdf.js (legacy build funciona melhor no Node)
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 10000;

/* ----------------------- Utils ----------------------- */
function numBR(v) {
  if (v == null) return null;
  const s = v
    .toString()
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "") // milhar
    .replace(/\./g, "")
    .replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
const round2 = (v) => (v == null ? null : parseFloat((Math.round(v * 100) / 100).toFixed(2)));
const isPct = (s) => /\d+,\d+%/.test(s);
const normSpaces = (s) => s.replace(/[^\S\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();

/* ----------------------- pdf.js helpers ----------------------- */
// Lê todas as páginas e retorna vetor de "items" com {str, x, y, w, h, page}
async function readPdfItems(buffer) {
  // Garante que sempre enviamos um Uint8Array, mesmo se for Buffer do Node
  let data;
  if (buffer instanceof Uint8Array) {
    data = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    data = new Uint8Array(buffer);
  } else if (Buffer.isBuffer(buffer)) {
    data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    throw new Error("Tipo de dados inválido: forneça um arquivo PDF binário (Buffer ou Uint8Array)");
  }

  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true
  }).promise;

  const allItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      const [a, b, c, d, e, f] = it.transform;
      allItems.push({
        page: p,
        str: it.str,
        x: e,
        y: f,
        w: it.width,
        h: it.height
      });
    }
  }
  return allItems;
}


// Agrupa itens por linha (aproximação por y) e ordena por x
function groupLines(items, tolerance = 2.0) {
  const sorted = [...items].sort((i, j) => j.y - i.y || i.x - j.x); // y desc, x asc
  const lines = [];
  for (const it of sorted) {
    let line = lines.find((ln) => Math.abs(ln.y - it.y) <= tolerance && ln.page === it.page);
    if (!line) {
      line = { page: it.page, y: it.y, items: [] };
      lines.push(line);
    }
    line.items.push(it);
  }
  // ordena itens por x em cada linha
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);
  // gera texto por linha
  for (const ln of lines) ln.text = ln.items.map((z) => z.str).join(" ");
  return lines;
}

// Encontra âncora por texto (case-insensitive)
function findAnchors(lines, pattern) {
  const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : pattern;
  return lines.filter((ln) => re.test(ln.text));
}

// Lê números à direita de uma âncora (mesma linha ou próxima)
function readRightOf(lines, anchor, maxDx = 400, take = 1) {
  const out = [];
  const aY = anchor.y, aXmax = Math.max(...anchor.items.map((i) => i.x + i.w));
  // mesma página e linha próxima em Y
  for (const ln of lines.filter((l) => l.page === anchor.page && Math.abs(l.y - aY) <= 2.5)) {
    for (const it of ln.items) {
      const within = it.x > aXmax && it.x - aXmax <= maxDx;
      if (within && /[\d.,-]/.test(it.str)) out.push(it.str);
    }
  }
  return out.slice(0, take);
}

// Lê bloco abaixo da âncora (retangulo)
function readBlockBelow(items, anchorLine, box = { dx: 0, dy: 0, w: 9999, h: 200 }) {
  const ax = Math.min(...anchorLine.items.map((i) => i.x));
  const ay = anchorLine.y;
  const rect = { x: ax + (box.dx || 0), yTop: ay - (box.dy || 0), w: box.w || 9999, h: box.h || 200 };
  const x2 = rect.x + rect.w;
  const yBottom = rect.yTop - rect.h;

  return items.filter(
    (it) =>
      it.page === anchorLine.page &&
      it.x >= rect.x &&
      it.x <= x2 &&
      it.y >= yBottom &&
      it.y <= rect.yTop
  );
}

/* ----------------------- Extrações (posicional + fallback) ----------------------- */
function extractByRegex(fullText) {
  const text = normSpaces(fullText);

  // Campos básicos (regex de apoio)
  const unidade_consumidora =
    (text.match(/(10\d{8,10})/) || [])[1] ||
    (text.match(/(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\/\d{4}\s+(\d{6,12})/i) || [])[2] ||
    (text.match(/UC\s*(\d{8,12})/i) || [])[1] ||
    null;

  const mes_ano_referencia = (text.match(/(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\/\d{4}/i) || [])[0] || null;

  const totalMatch = text.match(/R\$\*+\s*([\d.]+,\d{2})/);
  const total_a_pagar = totalMatch ? round2(numBR(totalMatch[1])) : null;

  const mVenc =
    text.match(/VENCIMENTO\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    text.match(/R\$\*+[\d.,]+\s*(\d{2}\/\d{2}\/\d{4})/);
  const data_vencimento = mVenc ? mVenc[1] : null;

  const data_emissao = (text.match(/EMISS[ÃA]O\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;

  const apresentacao =
    (text.match(/APRESENTA[ÇC][AÃ]O\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
    (text.match(/\b\d{2}\/\d{2}\/\d{4}\b(?=.*APRESENT)/i) || [])[0] ||
    null;

  // Consumidor → Leituras (fallback por trinca próxima do cabeçalho)
  let data_leitura_anterior = (text.match(/LEITURA\s+ANTERIOR.*?(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;
  let data_leitura_atual = (text.match(/LEITURA\s+ATUAL.*?(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;
  let data_proxima_leitura = (text.match(/PR[ÓO]XIMA\s+LEITURA.*?(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;

  if (!data_leitura_anterior || !data_leitura_atual) {
    const head = text.search(/R\$\*+[\d.,]+\s*\d{2}\/\d{2}\/\d{4}/);
    const window = head > -1 ? text.slice(Math.max(0, head - 250), head + 450) : text;
    const ds = Array.from(window.matchAll(/\b\d{2}\/\d{2}\/\d{4}\b/g)).map((m) => m[0]);
    const venc =
      (text.match(/VENCIMENTO\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] ||
      (text.match(/R\$\*+[\d.,]+\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] ||
      null;
    const seq = ds.filter((d) => d !== venc);
    if (!data_leitura_anterior) data_leitura_anterior = seq[0] || null;
    if (!data_leitura_atual) data_leitura_atual = seq[1] || null;
    if (!data_proxima_leitura) data_proxima_leitura = seq[2] || null;
  }

  // Benefícios / tributos
  const beneficio_tarifario_bruto = numBR((text.match(/BENEF[ÍI]CIO\s+TARIF[ÁA]RIO\s+BRUTO.*?([\d.,]+)/i) || [])[1]);
  const beneficio_tarifario_liquido = numBR(
    (text.match(/BENEF[ÍI]CIO\s+TARIF[ÁA]RIO\s+L[ÍI]QUIDO.*?(-?[\d.,]+)/i) || [])[1]
  );
  const icms = /ICMS/i.test(text) ? 0 : null;
  const pis_pasep = /PIS/i.test(text) ? 0 : null;
  const cofins = /COFINS/i.test(text) ? 0 : null;

  // Débito Automático
  let fatura_debito_automatico = "no";
  if (/FATURA\s+COM\s+LAN[ÇC]AMENTO\s+PARA\s+D[ÉE]BITO\s+AUTOM[ÁA]TICO/i.test(text)) fatura_debito_automatico = "yes";
  if (/Aproveite\s+os\s+benef[íi]cios\s+do\s+d[ée]bito\s+autom[áa]tico/i.test(text) || /\b0\d{9,}\b/.test(text))
    fatura_debito_automatico = "no";

  // Observações / Info p/ cliente
  const informacoes_para_o_cliente =
    (text.match(
      /INFORMA[ÇC][AÃ]OES?\s+PARA\s+O\s+CLIENTE[:\-]?\s*([\s\S]+?)(?=CADASTRO\s+RATEIO|NOTA\s+FISCAL|ENERGIA\s+ATIVA|A\s+EQUATORIAL|Processo|$)/i
    ) || [])[1] || null;

  const mObs = text.match(/Processo\s+\d+\s*-\s*[\d.-]+\s*-\s*Valor\s+controverso\s+R\$\s*[\d.,]+\./i);
  let observacoes = mObs ? mObs[0].replace(/\s*\n\s*/g, " ") : null;
  if (observacoes)
    observacoes = observacoes.replace(/R\$\s*([\d.]+)[.,](\d{2})/g, (m, a, b) => "R$ " + a.replace(/\./g, "") + "," + b);

  return {
    unidade_consumidora,
    mes_ano_referencia,
    total_a_pagar,
    data_vencimento,
    data_emissao,
    apresentacao,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    beneficio_tarifario_bruto,
    beneficio_tarifario_liquido,
    icms,
    pis_pasep,
    cofins,
    fatura_debito_automatico,
    informacoes_para_o_cliente,
    observacoes
  };
}

// Busca números (kWh, preço, total) em linhas contendo SCEE (posicional)
function extractSCEE_Positional(items, lines) {
  const result = {
    consumo: { preco_unit: null, quant: null, total: null, sem_tributos: null },
    injecoes: [] // [{uc, quant, preco_unit, total}]
  };

  // 1) Consumo SCEE (linha que contém "CONSUMO SCEE")
  const consAnch = findAnchors(lines, /CONSUMO\s+SCEE/i)[0];
  if (consAnch) {
    const rightTokens = consAnch.items.filter((it) => it.x > Math.max(...consAnch.items.map((i) => i.x + i.w)));
    // fallback: usa a própria linha
    const tokens = consAnch.items.concat(rightTokens).sort((a, b) => a.x - b.x).map((t) => t.str);

    // Procurar padrão: preço(6 casas), quantidade, (coluna intermediária opcional), total
    const joined = tokens.join(" ");
    const m =
      joined.match(/([01],\d{6})\s+([\d.]+,\d{2})(?:\s+[\d.]+,\d{2})?\s+([\d.]+,\d{2})/) ||
      consAnch.text.match(/([01],\d{6})\s+([\d.]+,\d{2})(?:\s+[\d.]+,\d{2})?\s+([\d.]+,\d{2})/);
    if (m) {
      result.consumo.preco_unit = numBR(m[1]);
      result.consumo.quant = numBR(m[2]);
      result.consumo.total = numBR(m[3]);
    }

    // Sem tributos na mesma faixa
    const semTrib = consAnch.text.match(/\b([01],\d{6})\b/);
    if (semTrib) result.consumo.sem_tributos = numBR(semTrib[1]);
  }

  // 2) Injeções SCEE — linhas com "INJEÇÃO SCEE" e "UC"
  const injAnchors = findAnchors(lines, /INJE[ÇC][AÃ]O\s+SCEE/i);
  for (const an of injAnchors) {
    // Captura bloco logo abaixo da âncora
    const blk = readBlockBelow(items, an, { dx: 0, dy: 5, w: 9999, h: 140 });
    const blLines = groupLines(blk);

    for (const ln of blLines) {
      if (!/UC\s*\d+/.test(ln.text)) continue;
      // Padrão: UC ######, kWh ##,##, preço 0,######, (tributo -##,##)?, total ##,##
      const mUC = ln.text.match(/UC\s*(\d{6,12}).*?kWh\s*([\d.]+,\d{2}).*?([01],\d{6}).*?(?:-?[\d.]+,\d{2})?.*?(-?[\d.]+,\d{2})/i);
      if (mUC) {
        result.injecoes.push({
          uc: mUC[1],
          quant: numBR(mUC[2]),
          preco_unit: numBR(mUC[3]),
          total: Math.abs(numBR(mUC[4]))
        });
      }
    }
  }

  return result;
}

/* ----------------------- Extração principal (combinada) ----------------------- */
async function extractFatura(buffer) {
  const items = await readPdfItems(buffer);
  const lines = groupLines(items);
  const fullText = normSpaces(lines.map((l) => l.text).join("\n"));

  // Básicos + datas/tributos via regex (fallback garantido)
  const head = extractByRegex(fullText);

  // Consumo/Injeções (posicional)
  const scee = extractSCEE_Positional(items, lines);

  // Bloco SCEE (posicional por âncora + regex dentro)
  const infoSCEEAnchor = findAnchors(lines, /INFORMA[ÇC][AÃ]OES?\s+DO\s+SCEE/i)[0];
  let geracao_ciclo = null,
    uc_geradora = null,
    uc_geradora_producao = null,
    excedente_recebido = null,
    credito_recebido = null,
    saldo_kwh_total = null,
    cadastro_rateio_geracao_uc = null,
    cadastro_rateio_geracao_percentual = null;

  if (infoSCEEAnchor) {
    const blk = readBlockBelow(items, infoSCEEAnchor, { dy: 6, w: 9999, h: 300 });
    const blText = normSpaces(groupLines(blk).map((l) => l.text).join(" "));
    geracao_ciclo = (blText.match(/\((\d{1,2}\/\d{4})\)/) || [])[1] || null;
    uc_geradora = (blText.match(/UC\s+(\d{8,12})/i) || [])[1] || null;
    uc_geradora_producao = numBR((blText.match(/UC\s+\d+\s*[:\-]?\s*([\d.]+,\d{2})/) || [])[1]);
    excedente_recebido = numBR((blText.match(/EXCEDENTE\s+RECEBIDO.*?([\d.]+,\d{2})/i) || [])[1]);
    credito_recebido = numBR((blText.match(/CR[ÉE]DITO\s+RECEBIDO.*?([\d.]+,\d{2})/i) || [])[1]);
    saldo_kwh_total = numBR((blText.match(/SALDO\s+KWH.*?([\d.]+,\d{2})/i) || [])[1]);
    cadastro_rateio_geracao_uc = (blText.match(/CADASTRO\s+RATEIO.*?UC\s+(\d+)/i) || [])[1] || null;
    cadastro_rateio_geracao_percentual = (blText.match(/=\s*([\d.,]+%)/) || [])[1] || null;
  }

  // Leituras do medidor (posicional: linha com "ENERGIA ATIVA - KWH")
  let leitura_anterior = null,
    leitura_atual = null;
  const energiaLines = lines.filter((ln) => /ENERGIA\s+ATIVA\s*-\s*KWH/i.test(ln.text));
  if (energiaLines[0]) {
    const m = energiaLines[0].text.match(/KWH\s+(\d+)\s+(\d+)[^\d]+(\d+)/i);
    if (m) {
      const atual = parseInt(m[1], 10);
      const consumo = parseInt(m[2], 10);
      const possAnt = parseInt(m[3], 10);
      if (Math.abs(atual - possAnt) === consumo) {
        leitura_atual = atual;
        leitura_anterior = possAnt;
      }
    }
  }

  // Tarifa sem tributos: pegue do consumo SCEE quando disponível
  let valor_tarifa_unitaria_sem_tributos = scee.consumo.sem_tributos;

  // Ajustes finais + arredondamentos
  const injecoes_scee = (scee.injecoes || []).map((it) => ({
    uc: it.uc,
    quant_kwh: it.quant == null ? null : round2(it.quant),
    preco_unit_com_tributos: it.preco_unit == null ? null : parseFloat(it.preco_unit.toFixed(6)),
    tarifa_unitaria: it.total == null ? null : round2(it.total)
  }));

  const consumo_scee_preco_unit_com_tributos =
    scee.consumo.preco_unit == null ? null : parseFloat(scee.consumo.preco_unit.toFixed(6));
  const consumo_scee_quant = scee.consumo.quant == null ? null : round2(scee.consumo.quant);
  const consumo_scee_tarifa_unitaria = scee.consumo.total == null ? null : round2(scee.consumo.total);

  // média (se houver histórico no texto)
  const historicos = Array.from(fullText.matchAll(/\b(\d{3,4}),00\b/g)).map((m) => numBR(m[1] + ",00"));
  const media = historicos.length ? Math.round(historicos.reduce((a, b) => a + b, 0) / historicos.length) : null;

  return {
    unidade_consumidora: head.unidade_consumidora,
    total_a_pagar: head.total_a_pagar,
    data_vencimento: head.data_vencimento,
    data_leitura_anterior: head.data_leitura_anterior,
    data_leitura_atual: head.data_leitura_atual,
    data_proxima_leitura: head.data_proxima_leitura,
    data_emissao: head.data_emissao,
    apresentacao: head.apresentacao,
    mes_ano_referencia: head.mes_ano_referencia,
    leitura_anterior,
    leitura_atual,
    beneficio_tarifario_bruto: head.beneficio_tarifario_bruto,
    beneficio_tarifario_liquido: head.beneficio_tarifario_liquido,
    icms: head.icms,
    pis_pasep: head.pis_pasep,
    cofins: head.cofins,
    fatura_debito_automatico: head.fatura_debito_automatico,
    credito_recebido,
    saldo_kwh_total,
    excedente_recebido,
    geracao_ciclo,
    uc_geradora,
    uc_geradora_producao,
    cadastro_rateio_geracao_uc,
    cadastro_rateio_geracao_percentual,
    valor_tarifa_unitaria_sem_tributos,
    injecoes_scee,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media,
    informacoes_para_o_cliente: head.informacoes_para_o_cliente,
    observacoes: head.observacoes
  };
}

/* ----------------------- Validator (accuracy) ----------------------- */
function approx(a, b, eps = 0.05) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}
function score(pred, gold) {
  const notes = [];
  let total = 0,
    ok = 0;

  function mark(name, pass, exp, got) {
    total++;
    if (pass) ok++;
    else notes.push({ field: name, expected: exp, got });
  }

  // Campos comparados (podemos estender conforme necessidade)
  mark("unidade_consumidora", pred.unidade_consumidora === gold.unidade_consumidora, gold.unidade_consumidora, pred.unidade_consumidora);
  mark("total_a_pagar", approx(pred.total_a_pagar, gold.total_a_pagar, 0.01), gold.total_a_pagar, pred.total_a_pagar);
  mark("data_vencimento", pred.data_vencimento === gold.data_vencimento, gold.data_vencimento, pred.data_vencimento);
  mark("data_leitura_anterior", pred.data_leitura_anterior === gold.data_leitura_anterior, gold.data_leitura_anterior, pred.data_leitura_anterior);
  mark("data_leitura_atual", pred.data_leitura_atual === gold.data_leitura_atual, gold.data_leitura_atual, pred.data_leitura_atual);
  mark("data_proxima_leitura", pred.data_proxima_leitura === gold.data_proxima_leitura, gold.data_proxima_leitura, pred.data_proxima_leitura);
  mark("data_emissao", pred.data_emissao === gold.data_emissao, gold.data_emissao, pred.data_emissao);
  mark("apresentacao", pred.apresentacao === gold.apresentacao, gold.apresentacao, pred.apresentacao);
  mark("mes_ano_referencia", pred.mes_ano_referencia === gold.mes_ano_referencia, gold.mes_ano_referencia, pred.mes_ano_referencia);
  mark("leitura_anterior", pred.leitura_anterior === gold.leitura_anterior, gold.leitura_anterior, pred.leitura_anterior);
  mark("leitura_atual", pred.leitura_atual === gold.leitura_atual, gold.leitura_atual, pred.leitura_atual);

  // SCEE
  mark("consumo_scee_preco_unit", approx(pred.consumo_scee_preco_unit_com_tributos, gold.consumo_scee_preco_unit_com_tributos, 1e-5), gold.consumo_scee_preco_unit_com_tributos, pred.consumo_scee_preco_unit_com_tributos);
  mark("consumo_scee_quant", approx(pred.consumo_scee_quant, gold.consumo_scee_quant, 0.01), gold.consumo_scee_quant, pred.consumo_scee_quant);
  mark("consumo_scee_total", approx(pred.consumo_scee_tarifa_unitaria, gold.consumo_scee_tarifa_unitaria, 0.05), gold.consumo_scee_tarifa_unitaria, pred.consumo_scee_tarifa_unitaria);

  // Injeções
  if (Array.isArray(gold.injecoes_scee)) {
    mark("inj_len", (pred.injecoes_scee || []).length === gold.injecoes_scee.length, gold.injecoes_scee.length, (pred.injecoes_scee || []).length);
    for (let i = 0; i < Math.min((pred.injecoes_scee || []).length, gold.injecoes_scee.length); i++) {
      const g = gold.injecoes_scee[i], pr = pred.injecoes_scee[i] || {};
      mark(`inj[${i}].uc`, pr.uc === g.uc, g.uc, pr.uc);
      mark(`inj[${i}].quant`, approx(pr.quant_kwh, g.quant_kwh, 0.01), g.quant_kwh, pr.quant_kwh);
      mark(`inj[${i}].preco`, approx(pr.preco_unit_com_tributos, g.preco_unit_com_tributos, 1e-5), g.preco_unit_com_tributos, pr.preco_unit_com_tributos);
      mark(`inj[${i}].total`, approx(pr.tarifa_unitaria, g.tarifa_unitaria, 0.05), g.tarifa_unitaria, pr.tarifa_unitaria);
    }
  }

  const accuracy = +(ok / total * 100).toFixed(1);
  return { accuracy, ok, total, fails: notes };
}

/* ----------------------- Rotas ----------------------- */
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    app: "extract-equatorialpdfjs-v1.0",
    env: process.env.NODE_ENV || "production",
    node: process.version,
    pdfjs: "ok",
    uptime_sec: Math.floor(process.uptime()),
    mem_mb: {
      rss: +(process.memoryUsage().rss / 1048576).toFixed(1),
      heapUsed: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
      heapTotal: +(process.memoryUsage().heapTotal / 1048576).toFixed(1),
    },
    now: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    port: PORT,
    message: "Servidor pdfjs Equatorial operacional ✅"
  });
});

app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo PDF não enviado" });
    const out = await extractFatura(req.file.buffer);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// POST /validate  (Body: form-data -> file + gold (json string opcional))
app.post("/validate", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo PDF não enviado" });
    const pred = await extractFatura(req.file.buffer);

    let gold = null;
    try { if (req.body.gold) gold = JSON.parse(req.body.gold); } catch { gold = null; }

    if (!gold) {
      return res.json({ prediction: pred, note: "Envie 'gold' (JSON) no form-data para calcular acurácia." });
    }
    const report = score(pred, gold);
    res.json({ prediction: pred, report });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor online na porta ${PORT}`);
});
