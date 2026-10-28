FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
# The store writes its JSON files here by default, so the directory must be
# writable by the unprivileged user the server runs as. DATA_DIR can still be
# pointed at a mounted volume at deploy time.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]