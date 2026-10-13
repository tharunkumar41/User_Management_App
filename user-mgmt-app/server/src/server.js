const http = require('http');
const env = require('./config/env');
const app = require('./app');
const { initSocket } = require('./realtime/socket');

// Socket.IO needs the raw HTTP server, not just the Express app.
const server = http.createServer(app);
initSocket(server);

server.listen(env.PORT, () => console.log(`API running on http://localhost:${env.PORT}`));
