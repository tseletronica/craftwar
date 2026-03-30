# Guia de Deploy Híbrido: Migrando para VPS (Ubuntu/Debian)

Como o projeto já está estruturado perfeitamente em `docker-compose.yml`, subir na VPS é surpreendentemente simples. O *Docker* fará todo o trabalho pesado.

Nesta arquitetura, recomendamos uma **VPS de pelo menos 6GB a 8GB de RAM** (pois você vai ligar **7 servidores Bedrock** ao mesmo tempo e o backend Fastify). Uma VPS Linux simples na Hetzner, Contabo, DigitalOcean ou AWS servirá.

## Passo 1: Preparando a VPS (Linux)

Assim que conectar via SSH na sua máquina nova, instale o **Docker**:

```bash
# Atualizar as listas do Ubuntu/Debian
sudo apt update && sudo apt upgrade -y

# Instalar o Docker Script Oficial
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Ativar Docker para rodar no boot
sudo systemctl enable docker
sudo systemctl start docker

# Instalar Docker Compose integrado
sudo apt-get install docker-compose-plugin -y
```

## Passo 2: Transferindo os Arquivos

Você não precisa enviar todos os dados. O melhor é zipar as seguintes pastas, mandá-las via *SFTP (FileZilla/WinSCP)* e descompactar lá na pasta `/root/nations` (ou outra que preferir criar):

**Pastas que VOCÊ TEM QUE ENVIAR:**
*   `backend/` (Com o código API TS)
*   `addon/` (Com os pacotes behavior)
*   `docker/` (Dockerfile customizado do bedrock)
*   `Template Nação/` (As construções)
*   `docker-compose.yml` e `.env`
*   `runtime/` (APENAS se quiser continuar os mesmos mundos salvos do seu PC. Se quiser resetar os mundos, nem precisa enviar, o docker criará automático).

**Opcional mas pesado:** A pasta de binário oficial do Minecraft `bedrock-server-1.26.10.4-linux`. 
Se a sua internet for muito demorada para fazer o upload via FileZilla, você pode baixar lá na VPS diretamente:
```bash
wget https://minecraft.azureedge.net/bin-linux/bedrock-server-1.26.10.04.zip
unzip bedrock-server-1.26.10.04.zip -d bedrock-server-1.26.10.4-linux
```

## Passo 3: Configurar o `.env` (Muito Importante)

Abra e edite o seu `.env` que está na VPS. Você precisará de duas alterações críticas:

```env
# Seu Supabase DB
SUPABASE_DB_URL=postgresql://sua:senha_real@supabase...

# IP DE TRANSFERÊNCIA
# IMPORTANTE: Coloque AQUI O IP PÚBLICO DA SUA VPS (Em vez do IP 192.168 local do seu PC)
TRANSFER_HOST=172.24.16.89 # Exemplo do IP da Hetzner
```

> [!WARNING]
> **NETWORK_BASE_URL** não muda! Ele continua `http://api:8080`, pois o sistema vai "falar" entre os containers de modo seguro, com ping de latência 0. O Fastify nunca precisará estar publicamente exposto para a internet da porta 8080 (a menos que crie um site web por aí mais pra frente).

## Passo 4: Liberar Portas no Firewall

Sua VPS precisa permitir jogadores entrando nos vários proxies. Tem que liberar todas as portas do `docker-compose.yml`. E atenção: Porta de jogo Bedrock **SEMPRE É MODO UDP**.

```bash
sudo ufw allow ssh
sudo ufw allow 19132:19138/udp
sudo ufw enable
```

## Passo 5: Ligar "A Máquina"

Na VPS, navegue até a pasta onde jogou os arquivos:

```bash
cd /root/nations
# O parâmetro '-d' faz o servidor não morrer se você fechar o SSH sem querer
sudo docker compose up -d --build
```

O comando acima vai compilar o TS do Backend e iniciar em cadeia os 7 mundos. Caso dê "Erro de permissão" em pastas (como no `runtime`), rode: `sudo chmod -R 777 runtime`.

### Passo 6: Como Monitorar Depois

Se precisar ver se a API travou ou o que estão dizendo em tempo real no console do *Mapa Capital*, os comandos de diagnóstico são rápidos:

```bash
docker compose logs -f api          # Ver o log da API Supabase
docker compose logs -f capital      # Ver o chat/console do Servidor Capital
docker compose logs -f water        # Ver o MS da Nação da Água 
```

---
> [!NOTE]
> Você pode abrir mais o painel do seu hospedeiro/Cloud da VPS (ex: Painel de Segurança da AWS ou Azure) pra garantir que a Porta `19132 até 19138 UDP` esteja definida como *Permitida / Allow*.
