FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY game.js server.js ./
COPY public ./public
RUN chown -R node:node /app
USER 1000:1000
ENV PORT=8106
ENV BASE_PATH=/citadella
ENV REDIS_URL=redis://redis-service:6379
EXPOSE 8106
CMD ["node", "server.js"]
