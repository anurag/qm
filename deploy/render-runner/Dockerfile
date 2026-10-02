FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache bash ca-certificates curl git python3 py3-pip make g++ util-linux tini \
  && addgroup -g 10001 -S app \
  && adduser -S -D -u 10001 -G app -h /home/app app
COPY start.mjs /opt/qm/start.mjs
WORKDIR /app
RUN chown -R app:app /app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/opt/qm/start.mjs"]
