// @flow
import {
  FifoDispatcher,
  WebsocketTransport,
  BaseSendQueue,
  FifoQueue,
  JSONSerializer,
  ChannelsApi,
} from './lib/channels-api';


export default {
  FifoDispatcher,
  WebsocketTransport,
  BaseSendQueue,
  FifoQueue,
  JSONSerializer,
  ChannelsApi,

  /**
   * Configure a ChannelsApi client and begin connection
   *
   * @param url WebSocket URL to connect to
   * @param wsOptions Options to pass to ReconnectingWebsocket
   */
  connect(url: string, wsOptions: Object): ChannelsApi {
    const client = this.createClient(url, wsOptions);
    client.initialize();
    return client;
  },

  /**
   * Create a configured ChannelsApi client instance, using default components
   *
   * @param url WebSocket URL to connect to
   * @param wsOptions Options to pass to ReconnectingWebsocket
   */
  createClient(url: string, wsOptions: Object): ChannelsApi {
    const dispatcher = new FifoDispatcher();
    const transport = new WebsocketTransport(url, wsOptions);
    const queue = new FifoQueue();
    const serializer = new JSONSerializer();
    return new ChannelsApi(dispatcher, transport, queue, serializer);
  },
}
