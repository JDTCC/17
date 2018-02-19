const requestIp = require('request-ip')
const isLocalhost = require('app/utils/is-localhost')

const register = async (server, options) => {
  const requiredHeaders = ['nethash', 'version', 'port', 'os']

  server.ext({
    type: 'onRequest',
    method: async (request, h) => {
      if ((request.path.startsWith('/internal') || request.path.startsWith('/remote')) && !isLocalhost(request.info.remoteAddress)) {
        return h.response({
          code: 'ResourceNotFound',
          message: `${request.path} does not exist`
        }).code(400).takeover()
      }

      if (request.path.startsWith('/peer')) {
        const peer = {}
        peer.ip = requestIp.getClientIp(request);
        requiredHeaders.forEach(key => (peer[key] = request.headers[key]))

        try {
          await server.app.p2p.acceptNewPeer(peer)
        } catch (error) {
          return h.response({ success: false, message: error.message }).code(500).takeover()
        }
      }

      return h.continue
    }
  })
}

exports.plugin = {
  name: 'hapi-p2p-accept-request',
  version: '1.0.0',
  register
}
