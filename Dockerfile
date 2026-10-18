FROM node:26-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=3909 DB_PATH=/data/housie.db
EXPOSE 3909

CMD ["node", "server/index.js"]
