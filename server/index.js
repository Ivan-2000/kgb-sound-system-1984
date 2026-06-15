const http = require('node:http')
const { Server } = require('socket.io')
const { RoomManager } = require('./rooms/roomManager')
const { registerSocketHandlers } = require('./socket/registerSocketHandlers')

const PORT = Number(process.env.PORT || 3001)

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
})

const io = new Server(server, {
  cors: {
    origin: '*',
  },
  // Bound per-message size (AUDIT §3.2). Big enough for recorded WAV clips
  // relayed via `clip:file`, small enough to cap a single abusive payload.
  maxHttpBufferSize: 16 * 1024 * 1024,
})

const roomManager = new RoomManager()
registerSocketHandlers(io, roomManager)

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`KGB signaling server listening on :${PORT}`)
})
