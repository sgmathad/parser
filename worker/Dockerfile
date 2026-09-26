FROM node:22-alpine

WORKDIR /app

COPY ./package*.json ./

RUN npm install --legacy-peer-deps

COPY ./ ./

RUN npm run build

# this removes the devDependencies 
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "build/index.js"]