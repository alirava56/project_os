import { createServer } from 'node:http';
import { once } from 'node:events';

export async function localProvider(handler) {
  const server = createServer(async (request,response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const raw = Buffer.concat(parts).toString('utf8');
      await handler(request,response,raw ? JSON.parse(raw) : undefined);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    request(url,options) {
      const target = new URL(url);
      if (!['https://api.telegram.org','https://api.resend.com','https://vault.example.test'].includes(target.origin)) {
        throw new Error('Unexpected test provider origin');
      }
      return fetch(origin + target.pathname,options);
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function reply(response,status,body,headers={}) {
  response.writeHead(status,{'Content-Type':'application/json',...headers});
  response.end(JSON.stringify(body));
}

export const providerFixtureEnv = {
  PROJECTOS_TELEGRAM_NOTIFICATIONS:'enabled',
  PROJECTOS_TELEGRAM_BOT_TOKEN:'12345:synthetic-mock-only-0123456789',
  PROJECTOS_TELEGRAM_CHAT_ID:'-123456789',
  PROJECTOS_TELEGRAM_PROJECT_DETAILS:'enabled',
  PROJECTOS_EMAIL_NOTIFICATIONS:'enabled',
  PROJECTOS_RESEND_API_KEY:'synthetic_mock_resend',
  PROJECTOS_EMAIL_FROM:'sender@example.test',
  PROJECTOS_EMAIL_TO:'recipient@example.test',
};
