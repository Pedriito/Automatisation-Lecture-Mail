/**
 * app/api/triage/route.ts
 *
 * Triage email IMAP -> Groq -> Telegram, en Route Handler Next.js.
 */


import { request } from 'http';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Obligatoire : le runtime Edge n'a pas de sockets TCP, donc pas d'IMAP.
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TELEGRAM_LIMIT = 3900;
const MAX_MAILS = 40;
const MAX_BODY = 1500;
const MAX_TOTAL = 20_000;



const SYSTEM_PROMPT = `Tu es un assistant de triage d'emails. On te fournit les messages non lus.
Produis un compte rendu court en français, sans préambule, structuré ainsi :
1. URGENT / À traiter aujourd'hui (expéditeur entre parenthèses)
2. À lire quand tu as le temps
3. Ignorable (newsletters, notifications automatiques)
Une ligne par email maximum, formulation télégraphique. Utilise des émojis pour illustrer le sujet.
S'il semble avoir des taches à faire, liste les de la façon suivante: 
1. Tache 1 : Ranger le bureau 
2. Tache 2 : Appeler Anis
Si une section est vide, écris « aucun ».`;

type Mail = {
  from: string;
  subject: string;
  date: string;
  body: string;
};

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
}

// --------------------------------------------------------------------------- //
// Étape 1 : IMAP
// --------------------------------------------------------------------------- //
async function fetchUnseen(): Promise<{ mails: Mail[]; uids: number[] }> {
  const client = new ImapFlow({
    host: env('IMAP_HOST'),
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user: env('IMAP_USER'), pass: env('IMAP_PASS') },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(process.env.IMAP_FOLDER ?? 'INBOX');

  try {
    const found = await client.search({ seen: false }, { uid: true });
    const uids = (found || []).slice(0, MAX_MAILS);
    if (uids.length === 0) return { mails: [], uids: [] };

    const mails: Mail[] = [];
    for await (const msg of client.fetch(
      { uid: uids.join(',') },
      { uid: true, source: true },
      { uid: true },
    )) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = (parsed.text ?? parsed.html ?? '')
        .toString()
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      mails.push({
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '(sans objet)',
        date: parsed.date?.toISOString() ?? '',
        body: body.slice(0, MAX_BODY),
      });
    }

    return { mails, uids };
  } finally {
    lock.release();
    await client.logout().catch(() => { });
  }
}

/** Le flag \Seen tient lieu d'état persistant : rien à stocker ailleurs. */
async function markSeen(uids: number[]): Promise<void> {
  if (uids.length === 0) return;

  const client = new ImapFlow({
    host: env('IMAP_HOST'),
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user: env('IMAP_USER'), pass: env('IMAP_PASS') },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(process.env.IMAP_FOLDER ?? 'INBOX');
  try {
    await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true });
  } finally {
    lock.release();
    await client.logout().catch(() => { });
  }
}

// --------------------------------------------------------------------------- //
// Étapes 2 à 4 : agrégation, Groq, Telegram
// --------------------------------------------------------------------------- //
function aggregate(mails: Mail[]): string {
  return mails
    .map(
      (m, i) =>
        `--- Email ${i + 1} ---\nDe : ${m.from}\nObjet : ${m.subject}\n` +
        `Date : ${m.date}\n\n${m.body}`,
    )
    .join('\n\n')
    .slice(0, MAX_TOTAL);
}

async function askGroq(digest: string): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('GROQ_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: digest },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) throw new Error(`Groq ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function sendTelegram(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env('TELEGRAM_TOKEN')}/sendMessage`;
  for (const part of chunk(text, TELEGRAM_LIMIT)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env('TELEGRAM_CHAT_ID'),
        text: part,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status} : ${await res.text()}`);
  }
}

// --------------------------------------------------------------------------- //
// Handler
// --------------------------------------------------------------------------- //
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { mails, uids } = await fetchUnseen();

    if (mails.length === 0) {
      await sendTelegram('📭 Aucun nouvel email non lu.');
      return Response.json({ status: 'ok', count: 0 });
    }

    let summary: string;
    try {
      summary = await askGroq(aggregate(mails));
    } catch (err) {
      const fallback = mails.map((m) => `• ${m.subject} — ${m.from}`).join('\n');
      summary = `⚠️ Résumé LLM indisponible (${err}).\nObjets reçus :\n${fallback}`;
    }

    await sendTelegram(`📬 ${mails.length} email(s)\n\n${summary}`);
  
    await sendTelegram(`📬 ${mails.length} email(s)\n\n${summary}`);
    await markSeen(uids);

    await markSeen(uids); // seulement après notification réussie

    return Response.json({ status: 'ok', count: mails.length });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[triage]', message);
    console.log('ENV', Object.keys(process.env).filter((k)=>k.startsWith('IMAP')));
    await sendTelegram(`⚠️ Triage email : échec\n${message}`).catch(() => { });
    return Response.json({ error: message }, { status: 500 });
  }
}
