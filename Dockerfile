FROM node:20-slim

RUN groupadd -r clawd && useradd -r -g clawd -m clawd

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ ./src/
COPY public/ ./public/
COPY version.json ./

RUN mkdir -p /app/auth_state && chown -R clawd:clawd /app

VOLUME /app/auth_state

USER clawd

EXPOSE 8080

CMD ["node", "src/index.js"]
