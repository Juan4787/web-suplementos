const certificationUrl = process.env.AI_CERTIFICATION_URL ?? 'http://127.0.0.1:8787';

const allModels = ['gpt_oss_120b_groq_v1', 'glm_4_7_flash_cf_v1'];
const allCases = [
  'sales_summary',
  'inventory_priority',
  'inventory_catalog',
  'highest_price',
  'sales_comparison',
  'product_performance',
  'product_performance_empty',
  'write_refusal'
];
const selectedValues = (value, allowed, label) => {
  if (!value) return allowed;
  const selected = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (selected.length === 0 || selected.some((entry) => !allowed.includes(entry))) {
    throw new Error(`Invalid ${label} selection`);
  }
  return selected;
};
const models = selectedValues(process.env.AI_CERTIFICATION_MODELS, allModels, 'model');
const cases = selectedValues(process.env.AI_CERTIFICATION_CASES, allCases, 'case');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const RETRYABLE_CERTIFICATION_FAILURES = new Set([
  'provider:groq:rate_limit',
  'provider:groq:server',
  'provider:groq:timeout',
  'provider:cloudflare:rate_limit',
  'provider:cloudflare:server',
  'provider:cloudflare:capacity',
  'provider:cloudflare:timeout'
]);

const readJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Certification endpoint returned non-JSON content with status ${response.status}`);
  }
};

const manifestResponse = await fetch(`${certificationUrl}/cases`, {
  headers: { Accept: 'application/json' }
});
const manifest = await readJson(manifestResponse);
if (!manifestResponse.ok) throw new Error('Unable to read the certification manifest');

for (const model of models) {
  if (!Array.isArray(manifest.models) || !manifest.models.includes(model)) {
    throw new Error(`Certification model is not exposed by the preview worker: ${model}`);
  }
}
for (const certificationCase of cases) {
  if (!Array.isArray(manifest.cases) || !manifest.cases.includes(certificationCase)) {
    throw new Error(`Certification case is not exposed by the preview worker: ${certificationCase}`);
  }
}

let passed = 0;
for (const model of models) {
  for (const [caseIndex, certificationCase] of cases.entries()) {
    const url = new URL('/certify', certificationUrl);
    url.searchParams.set('model', model);
    url.searchParams.set('case', certificationCase);
    let completed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
      const result = await readJson(response);
      if (response.ok && result.passed === true) {
        passed += 1;
        completed = true;
        console.log(`PASS ${model}/${certificationCase} evidence=${result.evidenceCount}`);
        break;
      }
      const failure = typeof result.failure === 'string' ? result.failure : 'unknown';
      if (RETRYABLE_CERTIFICATION_FAILURES.has(failure) && attempt < 2) {
        console.log(`WAIT ${model}/${certificationCase} transient=${failure}`);
        await sleep(failure.endsWith(':rate_limit') ? 30_000 : 5_000);
        continue;
      }
      throw new Error(`Certification failed for ${model}/${certificationCase}: ${failure}`);
    }
    if (!completed) throw new Error(`Certification did not complete for ${model}/${certificationCase}`);
    if (model.startsWith('gpt_oss_') && caseIndex < cases.length - 1) await sleep(12_000);
    if (model.startsWith('glm_') && caseIndex < cases.length - 1) await sleep(3_000);
  }
}

console.log(`Certification complete: ${passed}/${models.length * cases.length} cases passed`);
