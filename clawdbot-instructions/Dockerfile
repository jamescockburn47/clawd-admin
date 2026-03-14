FROM node:20-slim

RUN groupadd -r monet && useradd -r -g monet -m monet

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ ./src/
COPY CLAUDE.md ./

RUN mkdir -p /app/auth_state && chown -R monet:monet /app

VOLUME /app/auth_state

USER monet

CMD ["node", "src/index.js"]
