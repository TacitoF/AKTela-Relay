# AKTela Relay — Cloudflare Durable Objects

Relay WebSocket por sala para o AKTela.

Cada código de 6 caracteres é roteado para um único Durable Object, garantindo que Capture e espectadores da mesma sala compartilhem a mesma instância.

## Deploy

1. Crie uma conta gratuita na Cloudflare.
2. Em Workers & Pages, crie/importa este projeto ou faça o deploy com Wrangler.
3. Após o deploy, teste `https://SEU-WORKER.workers.dev/health`.
4. Copie a URL WebSocket: `wss://SEU-WORKER.workers.dev/ws`.
5. No repositório da Activity AKTela v0.5.4, abra `public/relay.json` e coloque essa URL em `relayUrl`.
6. Faça commit. A Vercel redeploya a Activity, e o Capture v0.6.2 passa a descobrir o mesmo relay automaticamente.

## Por que isso existe

O relay antigo da Vercel mantinha as salas em um `Map` em memória. Em produção, publisher e viewer podem cair em instâncias diferentes da Function e não se enxergarem. Durable Objects roteiam todos os participantes de uma sala para o mesmo objeto.
