# AKTela Relay v2.0

Relay WebSocket da AKTela em Cloudflare Workers + Durable Objects.

## O que mudou

- Mantém o Capture enviando mídia binária diretamente para a Cloudflare.
- Viewers da Discord Activity usam `transport=text`.
- O relay converte cada pacote de mídia em um envelope base64 apenas no trecho Cloudflare -> Discord.
- Isso contorna clientes/proxies em que mensagens WebSocket binárias não chegam de forma consistente.
- Mantém suporte ao transporte binário para testes fora do Discord.
- Usa `locationHint: "sam"` na criação de novas salas para reduzir a latência para usuários da América do Sul quando possível.

A URL pública continua a mesma:

`https://aktela-relay.tacito1-filho.workers.dev`
