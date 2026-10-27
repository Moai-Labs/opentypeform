FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=3000
# The store must live somewhere writable by the unprivileged user. /data is
# provisioned and owned by node before the user switch; DATA_DIR=/data is the
# image's default and a runtime override (-e DATA_DIR=...) still wins for
# deployments that mount storage elsewhere. Without this, dataDir() would fall
# back to root-owned ./data and the store would fail with EACCES on boot.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]