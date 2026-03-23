async function aiCategorise(outgoings) {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) throw new Error('No API key');
  localStorage.setItem('tax_api_key', apiKey);

  const list = outgoings.map(t =>
    `ID:${t.id} | ${t.date} | ${t.description} | ref:${t.reference} | £${Math.abs(t.amount).toFixed(2)} | cat:${t.starlingCat} | type:${t.transactionType}`
  ).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: `You are a UK tax assistant helping a freelance UX/UI designer called Conagh Williams categorise bank transactions for self-assessment.

RULES:
- "deductible" = business expense. Be generous. Includes:
  - Any software subscription: Figma, Adobe, Webflow, Shopify, Notion, Claude, ChatGPT, OpenAI, Midjourney, Linear, Slack, Zoom, Dropbox, GitHub, Vercel, AWS, Netlify, Framer, Loom, Canva, Miro
  - Internet/broadband: TalkTalk, BT, Sky, Virgin Media, Plusnet
  - Phone bills
  - Domain/hosting fees
  - Coworking spaces
  - Professional courses, books, training
  - Business travel
  - Any recurring payment to a tech or software company
  - Spending Category is "EXPENSES" or "BILLS_AND_SERVICES"
- "ignore" = clearly personal or internal transfer:
  - Supermarkets, restaurants, takeaways, clothing, personal entertainment
  - Gyms, holidays, pharmacies, personal shopping
  - ANY transaction where the description or reference contains "Conagh Williams" — these are transfers to self
  - Spending Category is "INCOME", "SAVING", "TRANSFER" or "PAYMENTS"
  - Type is "FASTER_PAYMENT" or "TRANSFER" with no clear business purpose
- "review" = genuinely ambiguous. Only use when you truly cannot tell.

Return ONLY a valid JSON array, no markdown, no explanation:
[{"id":"t1","category":"deductible","reason":"Webflow subscription"},{"id":"t2","category":"ignore","reason":"transfer to self"}]`,
      messages: [{ role: 'user', content: list }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const rawText = data.content?.[0]?.text || '[]';
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch(e) {
    console.error('JSON parse failed:', rawText);
    return [];
  }
}