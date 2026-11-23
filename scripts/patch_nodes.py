import json
import os

wf_path = os.path.join(os.path.dirname(__file__), '../clients/ogabassey/workflows/ogabassey_hybrid_workflow.json')
with open(wf_path, 'r', encoding='utf-8') as f:
    wf = json.load(f)

helper_fn = """
function getClientConfig(tenantId) {
  const fs = require('fs');
  const candidatePaths = [
    process.env.TENANT_CONFIG_PATH,
    `/data/clients/${tenantId}/data/config.json`,
    `/data/clients/${tenantId}/config.json`,
    `./clients/${tenantId}/data/config.json`
  ].filter(Boolean);

  let cfg = {
    tenantId: tenantId,
    brandName: 'Our Team',
    supportPhone: '+2348146978921',
    businessHours: 'Mon–Sat 9am–6pm',
    salesRepJid: process.env.SALES_REP_JID || '2347014278724@s.whatsapp.net',
    websiteUrl: 'https://ogabassey.com',
    currencySymbol: '₦'
  };

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        cfg = { ...cfg, ...parsed };
        break;
      }
    } catch (e) {}
  }
  return cfg;
}
"""

code_handoff_holding = """const item = $input.first()?.json || {};
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
__HELPER_FN__
const cfg = getClientConfig(tenantId);
const replyText = `⏳ Your chat has been routed to ${cfg.brandName} sales team.\\n\\nA representative will reply here shortly.\\n\\n📞 Urgent? Call ${cfg.supportPhone} (${cfg.businessHours}).`;

return [{ json: { ...item, replyText, branch: 'handoff_holding' } }];""".replace('__HELPER_FN__', helper_fn)

code_classifier = """const item = $input.first()?.json || {};
const body = (item.body || '').toLowerCase().trim();
const rawStep = item.swapStep;
const swapStep = (rawStep !== null && rawStep !== undefined && rawStep !== '') ? parseInt(rawStep, 10) : null;

if (swapStep !== null && !isNaN(swapStep)) {
  return [{ json: { ...item, branchIndex: 1, swapStep, inSwapSession: true } }];
}

const priceRegex = /(?:how\\s*much|price|cost|how\\s*much\\s+is|what.*(?:cost|price)|how\\s*much.*for|price.*of)/i;
const deviceRegex = /(?:iphone|samsung|galaxy|pixel|redmi|redmi\\s+note|infinix|tecno|itel|oppo|honor|macbook|imac|mac\\s+mini|mac\\s+studio|ipad|airpods|watch\\s+ultra|watch\\s+se)\\s*\\d/i;
const deviceNameRegex = /(?:iphone|samsung|galaxy|pixel|redmi|infinix|tecno|itel|oppo|honor|macbook|imac|mac\\s+mini|mac\\s+studio|ipad)\\s+(?:air|duo|se|mini|pro|ultra|fold|flip|note|\\d{1,2})/i;

if (priceRegex.test(body) || deviceRegex.test(body) || deviceNameRegex.test(body)) {
  return [{ json: { ...item, branchIndex: 0, swapStep: null, inSwapSession: false } }];
}

if (/(?:swap|trade.?in|trade in|exchange|my\\s+(?:old|current|used)\\s+phone|sell\\s+my\\s+(?:phone|iphone|samsung)|want\\s+to\\s+swap|looking\\s+to\\s+swap)/i.test(body)) {
  return [{ json: { ...item, branchIndex: 1, swapStep: 0, inSwapSession: false } }];
}

if (/(?:address|location|where.*(?:shop|store|office|buy|find you)|map|direction|google\\s+map|open|clos(?:e|ed|ing)|hour|work\\s+hour|office\\s+hour|deliver|shipping|logistics|how\\s+long|when.*arrive|track|pickup|pick.?up|warranty|guarantee|return|refund)/i.test(body)) {
  return [{ json: { ...item, branchIndex: 2, swapStep: null, inSwapSession: false } }];
}

if (/(?:speak\\s+to|talk\\s+to|connect\\s+me|human|agent|representative|sales\\s+rep|rep|complaint|angry|problem|issue|not\\s+working|broken|damaged|urgent|help\\s+me|need\\s+help|support)/i.test(body)) {
  return [{ json: { ...item, branchIndex: 3, swapStep: null, inSwapSession: false } }];
}

return [{ json: { ...item, branchIndex: 4, swapStep: null, inSwapSession: false } }];"""

code_price_check = """const item = $input.first()?.json || {};
const fs = require('fs');
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
__HELPER_FN__
const cfg = getClientConfig(tenantId);

const candidatePaths = [
  process.env.TENANT_CATALOG_PATH,
  `/data/clients/${tenantId}/data/catalog.json`,
  `/data/clients/${tenantId}/catalog.json`,
  `./clients/${tenantId}/data/catalog.json`
].filter(Boolean);

let catalog = null;
for (const p of candidatePaths) {
  try {
    if (fs.existsSync(p)) {
      catalog = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    }
  } catch (e) {}
}

if (!catalog || !Array.isArray(catalog.products)) {
  return [{ json: { ...item, replyText: `⚠️ Product catalog is temporarily unavailable. Please visit ${cfg.websiteUrl} or call ${cfg.supportPhone} for live prices.`, branch: 'price_error' } }];
}

const body = (item.body || '').toLowerCase().trim();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}

const scored = [];
for (const p of catalog.products) {
  let score = 0;
  const pName = (p.name || '').toLowerCase();
  const pSku = (p.sku || '').replace(/-/g, ' ').toLowerCase();

  if (body.includes(pName)) score = Math.max(score, pName.length * 10);
  if (body.includes(pSku)) score = Math.max(score, pSku.length * 8);

  if (Array.isArray(p.aliases)) {
    for (const alias of p.aliases) {
      if (!alias || alias.length < 3) continue;
      const esc = escapeRegex(alias.toLowerCase());
      const regex = new RegExp('(?:^|[^a-z0-9])' + esc + '(?:$|[^a-z0-9])', 'i');
      if (regex.test(body)) {
        score = Math.max(score, alias.length * 5);
      }
    }
  }

  if (score > 0) scored.push({ product: p, score });
}

scored.sort((a, b) => b.score - a.score);
const matches = scored.map(s => s.product);

let replyText;
const curr = cfg.currencySymbol || '₦';
if (matches.length === 0) {
  return [{ json: { ...item, branchIndex: 4, branch: 'price_no_match_llm_escalation' } }];
} else if (matches.length === 1 || scored[0].score >= (scored[1]?.score || 0) * 1.5) {
  const p = matches[0];
  const warrantyText = p.warranty || (p.condition === 'New' ? 'Manufacturer warranty' : `1 year ${cfg.brandName} store warranty`);
  const priceVal = p.price_ngn || p.price || 0;
  const price = Number(priceVal).toLocaleString('en-NG');
  const priceSuffix = p.price_ngn_max ? ` – ${curr}${Number(p.price_ngn_max).toLocaleString('en-NG')}` : '';
  const storageNote = (p.storage_variants && p.storage_variants.length > 1) ? `\\n💾 Available: ${p.storage_variants.join(', ')}` : '';
  replyText = `📱 *${p.name}*\\n\\n💰 *Price:* ${curr}${price}${priceSuffix}\\n✨ *Condition:* ${p.condition || 'Used'}${storageNote}\\n🛡️ *Warranty:* ${warrantyText}\\n🔗 ${p.url || cfg.websiteUrl}\\n\\n_Reply "swap" to trade in your current device, or type your location for delivery details!_`;
} else {
  const list = matches.slice(0, 4).map(p => `• *${p.name}* (${p.condition || 'Used'}) — ${curr}${Number(p.price_ngn || p.price || 0).toLocaleString('en-NG')}`).join('\\n');
  replyText = `🔎 Found multiple matching options:\\n\\n${list}\\n\\n_Which specific storage or condition would you like details on?_`;
}

return [{ json: { ...item, replyText, branch: 'price_check' } }];""".replace('__HELPER_FN__', helper_fn)

code_swap_intake = """const item = $input.first()?.json || {};
const fs = require('fs');
const step = (item.swapStep !== null && item.swapStep !== undefined && item.swapStep !== '') ? parseInt(item.swapStep, 10) : 0;
let storedData = {};
try {
  storedData = item.swapData ? (typeof item.swapData === 'string' ? JSON.parse(item.swapData) : item.swapData) : {};
} catch (e) {}

const body = (item.body || '').trim();
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
const senderJid = item.senderJid;
__HELPER_FN__
const cfg = getClientConfig(tenantId);

let replyText, nextStep, newData, alertRep = false, alertText = null, swapComplete = false;

switch (step) {
  case 0:
    replyText = `🔄 *${cfg.brandName} Swap & Trade-In Service*\\n\\nLet's get your trade-in estimate! Step 1 of 4:\\n\\n📱 *What is the exact model of your current phone?* (e.g. iPhone 13 128GB or Samsung S22 Ultra)`;
    nextStep = 1;
    newData = {};
    break;
  case 1:
    newData = { ...storedData, model: body };
    replyText = `✅ Current device: *${body}*\\n\\nStep 2 of 4:\\n💾 *What is the storage capacity?* (e.g. 64GB, 128GB, 256GB, 512GB)`;
    nextStep = 2;
    break;
  case 2:
    newData = { ...storedData, storage: body };
    replyText = `✅ Storage: *${body}*\\n\\nStep 3 of 4:\\n🔋 *What is the battery health % and physical condition?* (e.g. 85%, clean screen, no cracks)`;
    nextStep = 3;
    break;
  case 3:
    newData = { ...storedData, batteryHealth: body };
    replyText = `✅ Condition noted!\\n\\nStep 4 of 4:\\n🎯 *Which phone or device do you want to swap TO?* (e.g. iPhone 15 Pro 128GB)`;
    nextStep = 4;
    break;
  case 4: {
    newData = { ...storedData, targetModel: body };
    swapComplete = true;
    nextStep = null;
    alertRep = true;

    const candidatePaths = [
      process.env.TENANT_CATALOG_PATH,
      `/data/clients/${tenantId}/data/catalog.json`,
      `/data/clients/${tenantId}/catalog.json`
    ].filter(Boolean);

    let targetInfo = '';
    let targetUrl = cfg.websiteUrl;
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          const catalog = JSON.parse(fs.readFileSync(p, 'utf8'));
          const targetBody = body.toLowerCase();
          const hit = catalog.products.find(prod =>
            (prod.aliases && prod.aliases.some(a => targetBody.includes(a.toLowerCase()))) ||
            targetBody.includes(prod.name.toLowerCase()) ||
            targetBody.includes((prod.sku || '').replace(/-/g, ' ').toLowerCase())
          );
          if (hit) {
            const curr = cfg.currencySymbol || '₦';
            const priceVal = hit.price_ngn || hit.price || 0;
            targetInfo = `\\n🎯 Target device retail: ${curr}${Number(priceVal).toLocaleString('en-NG')} (${hit.condition || 'Used'})`;
            targetUrl = hit.url || targetUrl;
          }}
          break;
        }
      } catch (e) {}
    }

    replyText = `🎉 *Swap Valuation Request Received!*\\n\\n📋 *Your Trade-in Summary:*\\n• Current Device: *${newData.model}* (${newData.storage || 'N/A'})\\n• Battery/Condition: *${newData.batteryHealth}*\\n• Target Upgrade: *${newData.targetModel}*${targetInfo}\\n\\n📍 Our technicians will inspect your device and calculate your exact balance top-up.\\n\\n👨‍💼 A sales representative from ${cfg.brandName} has been alerted and will follow up here shortly!`;
    alertText = `🚨 *NEW SWAP VALUATION REQUEST*\\n\\nCustomer: ${item.pushName || 'Customer'} (${senderJid})\\n• Trade-in: ${newData.model} ${newData.storage || ''}\\n• Condition: ${newData.batteryHealth}\\n• Desired Upgrade: ${newData.targetModel}\\n\\nPlease review and attend to this customer.`;
    break;
  }
  default:
    replyText = `🔄 Let's start your swap estimate:\\n\\n📱 *What is the exact model of your current phone?*`;
    nextStep = 1;
    newData = {};
}

return [{
  json: {
    ...item,
    replyText,
    nextStep: nextStep === null ? null : String(nextStep),
    swapDataOut: JSON.stringify(newData),
    alertRep,
    alertText,
    repJid: cfg.salesRepJid,
    swapComplete,
    branch: 'swap_intake'
  }
}];""".replace('__HELPER_FN__', helper_fn)

code_human_handoff = """const item = $input.first()?.json || {};
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
__HELPER_FN__
const cfg = getClientConfig(tenantId);
const now = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: true });

const customerReply = `👨‍💼 *Connecting You with a Sales Representative*\\n\\nI have notified the ${cfg.brandName} sales team. A representative will attend to your chat shortly.\\n\\n🕒 *Hours:* ${cfg.businessHours}\\n📞 *Direct line:* ${cfg.supportPhone}\\n\\n_Thank you for your patience!_`;

const repAlert = `🚨 *HUMAN REP ESCALATION REQUIRED*\\n\\n• Tenant: ${cfg.brandName} (${tenantId})\\n• Customer: ${item.pushName || 'Customer'} (${item.senderJid || 'Unknown JID'})\\n• Time: ${now}\\n• Last Message: "${item.body || ''}"\\n\\nPlease reply directly to this customer on WhatsApp.`;

return [{
  json: {
    ...item,
    replyText: customerReply,
    repAlertText: repAlert,
    repJid: cfg.salesRepJid,
    branch: 'human_handoff',
    handoffJid: item.senderJid,
    tenantId
  }
}];""".replace('__HELPER_FN__', helper_fn)

code_parse_llm = """const item = $input.first()?.json || {};
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
__HELPER_FN__
const cfg = getClientConfig(tenantId);

let replyText;
try {
  const llmResp = item;
  if (llmResp && llmResp.choices && llmResp.choices[0] && llmResp.choices[0].message) {
    replyText = llmResp.choices[0].message.content.trim();
  } else if (llmResp && llmResp.error) {
    throw new Error('LLM error: ' + (llmResp.error.message || JSON.stringify(llmResp.error)));
  } else {
    throw new Error('Unexpected LLM response shape');
  }
} catch (e) {
  replyText = `Hello! How can we assist you at ${cfg.brandName} today?\\n\\n• For device prices, reply with the model (e.g. "iPhone 15 Pro price")\\n• For trade-ins, reply "swap"\\n• For office address or delivery, reply "location"\\n• Or reply "human" to speak with a sales rep!`;
}
return [{ json: { ...item, replyText, branch: 'llm_rag' } }];""".replace('__HELPER_FN__', helper_fn)

code_build_eod = """const item = $input.first()?.json || {};
const tenantId = item.tenantId || process.env.TENANT_ID || 'ogabassey';
__HELPER_FN__
const cfg = getClientConfig(tenantId);

const now = new Date().toLocaleString('en-NG', {
  timeZone: 'Africa/Lagos',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
});

const eodMessage = `📊 *${cfg.brandName} End-of-Day Operations Summary*\\n\\n📅 Date: ${now}\\n🏢 Tenant: ${tenantId.toUpperCase()}\\n\\n✅ Automated WhatsApp Assistant status: Online & Healthy\\n📋 Daily intake queues processed.\\n\\nHave a great evening!`;

return [{ json: { ...item, tenantId, repJid: cfg.salesRepJid, eodMessage } }];""".replace('__HELPER_FN__', helper_fn)

updates = {
    'Code Handoff Holding': code_handoff_holding,
    'Code Classifier': code_classifier,
    'Code Price Check': code_price_check,
    'Code Swap Intake': code_swap_intake,
    'Code Human Handoff': code_human_handoff,
    'Code Parse LLM': code_parse_llm,
    'Code Build EOD Summary': code_build_eod
}

for node in wf['nodes']:
    name = node.get('name')
    if name in updates:
        node['parameters']['jsCode'] = updates[name]

with open(wf_path, 'w', encoding='utf-8') as f:
    json.dump(wf, f, indent=2, ensure_ascii=False)

print("Workflow nodes successfully updated with dynamic multi-tenant configuration!")
