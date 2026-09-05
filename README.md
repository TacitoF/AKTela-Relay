# AKTela Relay 3.2.1

Relay AKV5 em Cloudflare Workers com uma sala por Durable Object.

- Garante um único transmissor por sala e permite a reconexão da mesma sessão.
- Agrega os codecs suportados por todos os espectadores e informa o modo comum ao Capture.
- Sincroniza novos espectadores somente com um quadro-chave atual, evitando congelamentos e artefatos causados por referências antigas.
- Informa imediatamente ao Capture os espectadores que já estavam na sala.
- Valida capabilities e o envelope binário antes de retransmitir mídia.
- Encaminha sondas de latência de ponta a ponta entre Capture e espectadores.
