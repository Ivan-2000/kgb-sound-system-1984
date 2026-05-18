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
})

const roomManager = new RoomManager()
registerSocketHandlers(io, roomManager)

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`KGB signaling server listening on :${PORT}`)
})
