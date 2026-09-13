FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache bash ca-certificates curl git python3 py3-pip make g++ util-linux
COPY deploy/render-runner/start.mjs /opt/qm/start.mjs
WORKDIR /app
RUN chown -R node:node /app
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/opt/qm/start.mjs"]
