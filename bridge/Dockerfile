FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. src/ + proto/ are bind-mounted in dev
# (see docker-compose.yaml) so `tsx watch` hot-reloads on edit.
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY proto ./proto
COPY src ./src

CMD ["npm", "run", "dev"]
