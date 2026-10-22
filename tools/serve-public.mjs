// Production server for the built store. Railway sets PORT; a home
// launcher that does not still lands on 1420.
// SPDX-License-Identifier: GPL-3.0-or-later

import { preview } from 'vite';

const port = Number(process.env.PORT || 1420);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a TCP port between 1 and 65535.');
  process.exit(1);
}

const server = await preview({
  preview: {
    host: '0.0.0.0',
    port,
    strictPort: true,
  },
});

server.printUrls();
if (server.httpServer) {
  server.httpServer.on('error', (error) => {
    console.error(error?.message || 'preview server failed');
    process.exit(1);
  });
}
