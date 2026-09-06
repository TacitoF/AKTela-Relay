# AKTela Relay 3.3.0

Relay AKV5 em Cloudflare Workers com uma sala por Durable Object.

- Aceita até três transmissores por sala e preserva a posição de cada sessão durante reconexões.
- Descobre as transmissões ativas e entrega mídia somente aos espectadores inscritos naquela tela.
- Limita automaticamente salas com duas ou três telas a 720p e 30 FPS por transmissão.
- Agrega os codecs suportados por todos os espectadores e informa o modo comum ao Capture.
- Sincroniza novos espectadores somente com um quadro-chave atual, evitando congelamentos e artefatos causados por referências antigas.
- Informa imediatamente ao Capture os espectadores que já estavam na sala.
- Valida capabilities e o envelope binário antes de retransmitir mídia.
- Encaminha sondas de latência de ponta a ponta entre Capture e espectadores.
