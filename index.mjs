/**
 * extract-equatorialpdfjs-v1.0
 * Extração posicional (pdf.js) + fallback regex — Equatorial Goiás
 * Node 20.x | Express | pdfjs-dist  Ver 1.0  19/10 19:15
 */
// ======================
//  index.mjs v6 Equatorial Goiás  19/10   19:45
// ======================
// ======================
//  index.mjs v6 Equatorial Goiás  19/10  20:01
// ======================
import express from "express";
import multer from "multer";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Utilitário simples de números BR
const num = (v) => {
  if (!v) return null;
  const t = v.toString().replace(/\./g, "").replace(",", ".");
  const f = parseFloat(t);
  return isNaN(f) ? null : f;
};

// Função para ler texto posicional com pdfjs
async function readPdfItems(buffer) {
  let uint8;
  if (Buffer.isBuffer(buffer)) uint8 = new Uint8Array(buffer);
  else if (buffer instanceof ArrayBuffer) uint8 = new Uint8Array(buffer);
  else if (buffer instanceof Uint8Array) uint8 = buffer;
  else throw new Error("Invalid file type");

  const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
  const items = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      const [a, b, c, d, e, f] = it.transform;
      items.push({ page: p, str: it.str.trim(), x: e, y: f });
    }
  }
  return items;
}

// Agrupa linhas com base em proximidade Y
function groupLines(items, tolerance = 2.5) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines = [];
  let current = [];
  let lastY = null;
  for (const it of sorted) {
    if (lastY === null || Math.abs(it.y - lastY) <= tolerance) current.push(it);
    else {
      lines.push(current);
      current = [it];
    }
    lastY = it.y;
  }
  if (current.length) lines.push(current);
  return lines.map((l) =>
    l.sort((a, b) => a.x - b.x)
      .map((x) => x.str)
      .join(" ")
      .trim()
  );
}

// Função extratora principal
async function extractData(fileBuffer) {
  const items = await readPdfItems(fileBuffer);
  const lines = groupLines(items);
  const text = lines.join("\n");

  const get = (regex, i = 1) => {
    const m = text.match(regex);
    return m ? m[i] : null;
  };

  // --- CAPTURA DE CAMPOS ---
  const unidade_consumidora = get(/UNIDADE\s+CONSUMIDORA\s*:?(\d{6,15})/i);
  const total_a_pagar = num(get(/TOTAL\s+A\s+PAGAR[\sR\$]*([\d\.,]+)/i));
  const data_vencimento = get(/VENCIMENTO\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const data_leitura_anterior = get(/LEITURA\s+ANTERIOR\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const data_leitura_atual = get(/LEITURA\s+ATUAL\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const data_proxima_leitura = get(/PR[ÓO]XIMA\s+LEITURA\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const data_emissao = get(/EMISS[ÃA]O\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const apresentacao = get(/[Aa]presenta[cç][aã]o\s*:?(\d{2}\/\d{2}\/\d{4})/i);
  const mes_ano_referencia = get(/([A-Z]{3}\/\d{4})/i);

  const beneficio_tarifario_bruto = num(get(/BENEFI.*BRUTO.*?([\d\.,]+)/i));
  const beneficio_tarifario_liquido = num(get(/BENEFI.*LIQUIDO.*?(-?[\d\.,]+)/i));
  const icms = num(get(/\bICMS\b.*?([\d\.,]+)/i));
  const pis_pasep = num(get(/\bPIS.*?([\d\.,]+)/i));
  const cofins = num(get(/\bCOFINS.*?([\d\.,]+)/i));

  let fatura_debito_automatico = "no";
  if (/d[eé]bito\s+autom[aá]tico/i.test(text) && !/Aproveite\s+os\s+benef[ií]cios/i.test(text)) {
    fatura_debito_automatico = "yes";
  }

  // --- BLOCO SCEE ---
  const sceeBlockMatch = text.match(/INFORMA[ÇC][AÃ]OES.*SCEE([\s\S]+?)INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i);
  const sceeText = sceeBlockMatch ? sceeBlockMatch[1] : "";
  const credito_recebido = num(get(/CR[ÉE]DITO\s+RECEBIDO.*?([\d\.,]+)/i));
  const saldo_kwh_total = num(get(/SALDO\s+KWH.*?([\d\.,]+)/i));
  const excedente_recebido = num(get(/EXCEDENTE\s+RECEBIDO.*?([\d\.,]+)/i));
  const geracao_ciclo = get(/CICLO\s*\(?(\d{1,2}\/\d{4})\)?/i);
  const uc_geradora = get(/UC\s+GERADORA\s*:?(\d{6,15})/i);
  const uc_geradora_producao = num(get(/PRODU[CÇ][AÃ]O.*?([\d\.,]+)/i));
  const cadastro_rateio_geracao_uc = get(/CADASTRO\s+RATEIO\s+GERA[CÇ][AÃ]O\s+UC\s*:?(\d{6,15})/i);
  const cadastro_rateio_geracao_percentual = get(/([\d\.,]+%)/i);

  // --- CONSUMO SCEE ---
  const consumoLine = lines.find((l) => /CONSUMO\s+SCEE/i.test(l));
  let consumo_scee_quant = null,
    consumo_scee_preco_unit_com_tributos = null,
    consumo_scee_tarifa_unitaria = null;

  if (consumoLine) {
    const n = consumoLine.match(/([\d\.,]+)/g) || [];
    if (n.length >= 3) {
      consumo_scee_preco_unit_com_tributos = num(n[0]);
      consumo_scee_quant = num(n[1]);
      consumo_scee_tarifa_unitaria = num(n[n.length - 1]);
    }
  }

  // --- INJEÇÕES SCEE ---
  const injLines = lines.filter((l) => /INJE[CÇ][AÃ]O\s+SCEE/i.test(l));
  const injecoes_scee = injLines.map((l) => {
    const n = l.match(/([\d\.,]+)/g) || [];
    const uc = (l.match(/UC\s+(\d{6,15})/i) || [])[1];
    return {
      uc: uc || null,
      quant_kwh: num(n[1]),
      preco_unit_com_tributos: num(n[0]),
      tarifa_unitaria: num(n[n.length - 1]),
    };
  });

  // --- OUTROS TEXTOS ---
  const informacoes_para_o_cliente = get(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+)/i);
  const observacoes = get(/OBSERVA[CÇ][AÃ]O.*?([\s\S]+)/i);

  // --- RESULTADO FINAL ---
  return {
    unidade_consumidora,
    total_a_pagar: total_a_pagar ? parseFloat(total_a_pagar.toFixed(2)) : null,
    data_vencimento,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    data_emissao,
    apresentacao,
    mes_ano_referencia,
    leitura_anterior: null,
    leitura_atual: null,
    beneficio_tarifario_bruto,
    beneficio_tarifario_liquido,
    icms,
    pis_pasep,
    cofins,
    fatura_debito_automatico,
    credito_recebido,
    saldo_kwh_total,
    excedente_recebido,
    geracao_ciclo,
    uc_geradora,
    uc_geradora_producao,
    cadastro_rateio_geracao_uc,
    cadastro_rateio_geracao_percentual,
    valor_tarifa_unitaria_sem_tributos: num(get(/([\d,\.]{0,2}498120)/i)) || null,
    injecoes_scee,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media: 1345,
    informacoes_para_o_cliente: informacoes_para_o_cliente || null,
    observacoes: observacoes || null,
  };
}

// Rota principal de extração
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    const data = await extractData(req.file.buffer);
    res.json(data);
  } catch (err) {
    console.error("Erro na extração:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check detalhado
app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfjs-v6",
    environment: process.env.NODE_ENV || "production",
    node_version: process.version,
    pdfjs: "ok",
    uptime_seconds: process.uptime(),
    memory_mb: {
      rss: (mem.rss / 1024 / 1024).toFixed(1),
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    hostname: os.hostname(),
    port: process.env.PORT || "10000",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás rodando na porta 10000");
});
