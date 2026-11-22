FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache wget git

FROM base AS dependencies
COPY package*.json ./
RUN npm install --omit=dev

FROM base AS runner
WORKDIR /app
RUN mkdir -p /app/auth_info_baileys /app/media && chown -R node:node /app
USER node

COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . .

EXPOSE 3000
CMD ["node", "src/server.js"]
