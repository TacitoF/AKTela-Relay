# AKTela Relay 3.7.0

Relay AKV5 em Cloudflare Workers com uma sala por Durable Object.

- Preserva todos os pacotes de áudio válidos do lote enquanto sincroniza o vídeo a partir de um novo quadro-chave.
- Exclui espectadores com vídeo oculto da negociação de codec, sem interromper o áudio que continuam ouvindo.
- Agrupa por dois segundos pedidos simultâneos de keyframe por tela; ingresso, visibilidade e erro de decoder passam a exigir um único IDR.
- Aceita até três transmissores por sala e preserva a posição de cada sessão durante reconexões.
- Descobre as transmissões ativas e entrega mídia somente aos espectadores inscritos naquela tela.
- Interrompe vídeo para espectadores com a Activity oculta e exige um quadro-chave novo ao retomá-lo.
- Informa ao Capture quantos espectadores realmente consomem vídeo e áudio, permitindo pausar encoders ociosos.
- Agrega FPS, fila, descartes, microfaltas e travamentos dos players para a adaptação automática de qualidade.
- Reutiliza uma única conversão Base64 por variante de lote, em vez de reconverter a mesma mídia para cada espectador.
- Analisa lotes AKB1 por fatias do buffer original, sem copiar cada pacote antes do encaminhamento.
- Calcula o limite por transmissão a partir do layout dos espectadores: 720p30 para a grade, até 1080p60 para destaque quando todos os espectadores ativos daquela tela permitirem. Clientes anteriores conservam o limite de salas com várias telas.
- Agrega os codecs suportados pelos espectadores que recebem vídeo e informa o modo comum ao Capture.
- Sincroniza novos espectadores somente com um quadro-chave atual, evitando congelamentos e artefatos causados por referências antigas.
- Informa imediatamente ao Capture os espectadores que já estavam na sala.
- Valida capabilities e o envelope binário antes de retransmitir mídia.
- Encaminha sondas de latência de ponta a ponta entre Capture e espectadores.
- Recebe lotes AKB1 de vídeo e áudio, reduzindo em cerca de 6 a 9 vezes as mensagens cobradas pela Cloudflare, e continua aceitando AKV5 individual.
- Publica o nome de cada transmissor junto à posição da tela na grade.
