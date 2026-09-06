# AKTela Relay 3.4.0

Relay AKV5 em Cloudflare Workers com uma sala por Durable Object.

- Aceita até três transmissores por sala e preserva a posição de cada sessão durante reconexões.
- Descobre as transmissões ativas e entrega mídia somente aos espectadores inscritos naquela tela.
- Limita automaticamente salas com duas ou três telas a 720p e 30 FPS por transmissão.
- Agrega os codecs suportados por todos os espectadores e informa o modo comum ao Capture.
- Sincroniza novos espectadores somente com um quadro-chave atual, evitando congelamentos e artefatos causados por referências antigas.
- Informa imediatamente ao Capture os espectadores que já estavam na sala.
- Valida capabilities e o envelope binário antes de retransmitir mídia.
- Encaminha sondas de latência de ponta a ponta entre Capture e espectadores.
- Recebe lotes AKB1 de vídeo e áudio, reduzindo em cerca de 6 a 9 vezes as mensagens cobradas pela Cloudflare, e continua aceitando AKV5 individual.
- Publica o nome de cada transmissor junto à posição da tela na grade.
