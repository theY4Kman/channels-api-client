// @flow
import EventEmitter from 'events';
import ReconnectingWebsocket from 'reconnecting-websocket';
import autobind from 'autobind-decorator';
import isMatch from 'lodash/isMatch';
import pull from 'lodash/pull';
import logging from 'loglevel';

import UUID from './lib/UUID';

import type {
  IDispatcher,
  DispatchListener,
  MessageEvent,
  ISendQueue,
  ISerializer,
  IStreamingAPI,
  SubscriptionHandler,
  SubscriptionAction,
  ITransport,
} from './channels-api';


const log = logging.getLogger('channels-api');


/**
 * Invokes listeners on a first-registered, first-called basis
 */
class FifoDispatcher implements IDispatcher {
  static _listenerCounter: number = 0;

  _listeners: {[listenerId:number]: {selector: Object, handler: DispatchListener}};
  _listenersOrder: Array<number>;

  constructor() {
    this._listeners = {};
    this._listenersOrder = [];
  }

  listen(selector: Object, handler: DispatchListener): number {
    const listenerId = ++this.constructor._listenerCounter;
    this._listeners[listenerId] = {selector, handler};
    this._listenersOrder.push(listenerId);
    return listenerId;
  }

  once(selector: Object, handler: DispatchListener): number {
    const listenerId = this.listen(selector, payload => {
      this.cancel(listenerId);
      handler(payload);
    });
    return listenerId;
  }

  cancel(listenerId: number): boolean {
    const found = this._listeners.hasOwnProperty(listenerId);
    if (found) {
      delete this._listeners[listenerId];
      pull(this._listenersOrder, listenerId);
    }
    return found;
  }

  dispatch(payload: Object): number {
    let matches = 0;
    const listeners = this._listenersOrder.map(listenerId => this._listeners[listenerId]);
    listeners.forEach(({selector, handler}) => {
      if (isMatch(payload, selector)) {
        matches++;
        handler(payload);
      }
    });
    return matches;
  }
}


/**
 * Transport backed by a reconnecting websocket
 */
class WebsocketTransport extends EventEmitter implements ITransport {
  url: string;
  options: Object;
  socket: ReconnectingWebsocket;
  hasConnected: boolean;

  /**
   *
   * @param url Websocket URL to connect to
   * @param options Options to pass to ReconnectingWebsocket
   */
  constructor(url: string, options: Object={}) {
    super();
    this.url = url;
    this.options = options;
    this.socket = null;
    this.hasConnected = false;
  }

  @autobind
  connect() {
    if (this.socket != null) {
      log.debug('Attempt to connect already-connected socket ignored (%s)', this.url);
      return false;
    }

    log.info('Connecting to websocket at %s', this.url);
    this.socket = new ReconnectingWebsocket(this.url, [], this.options);
    this.socket.addEventListener('message', this._handleMessage);
    this.socket.addEventListener('open', this._handleOpen);
    return true;
  }

  @autobind
  isConnected() {
    if (this.socket == null) {
      return false;
    } else {
      return this.socket.readyState === this.socket.OPEN;
    }
  }

  @autobind
  send(bytes: string) {
    this._requireConnection();
    return this.socket.send(bytes);
  }

  @autobind
  _handleMessage(event: Event) {
    this.emit('message', event);
  }

  @autobind
  _handleOpen(event: Event) {
    this.emit('open', event);

    if (this.hasConnected) {
      this.emit('reconnect', event);
    } else {
      this.emit('connect', event);
      this.hasConnected = true;
    }
  }

  _requireConnection() {
    if (this.socket === null) {
      throw new Error('Socket not connected. Please call `initialize()` first.');
    }
  }
}


class BaseSendQueue implements ISendQueue {
  sendNow: (bytes: string) => number = (bytes) => -1;
  canSend: () => boolean = () => false;

  /**
   * @param sendNow Function to call to send a message
   * @param canSend Function which should return whether send can be called
   * @note If parameters are not passed, initialize() should be called later.
   */
  constructor(sendNow: ?(bytes: string) => number, canSend: ?() => boolean) {
    if (sendNow && canSend) {
      this.initialize(sendNow, canSend);
    } else if (sendNow || canSend) {
      throw new Error('Both sendNow and canSend must be provided, or neither must.');
    }
  }

  /**
   * @param sendNow Function to call to send a message
   * @param canSend Function which should return whether send can be called
   */
  initialize(sendNow: (bytes: string) => number, canSend: () => boolean) {
    this.sendNow = sendNow;
    this.canSend = canSend;
  }

  send(bytes: string) { throw new Error('not implemented'); }
  queueMessage(bytes: string) { throw new Error('not implemented'); }
  processQueue() { throw new Error('not implemented'); }
}


class FifoQueue extends BaseSendQueue implements ISendQueue {
  queue: Array<string>;

  constructor(sendNow?: (bytes: string) => number, canSend?: () => boolean) {
    super(sendNow, canSend);
    this.queue = [];
  }

  @autobind
  send(bytes: string): number {
    if (this.canSend()) {
      return this.sendNow(bytes);
    } else {
      this.queueMessage(bytes);
      return -1;
    }
  }

  @autobind
  queueMessage(bytes: string): boolean {
    log.debug('Queueing message to send later: %o', bytes);
    this.queue.push(bytes);
    return true;
  }

  @autobind
  processQueue(): number {
    let numProcessed = 0;

    if (this.queue.length) {
      log.debug(`Sending ${this.queue.length} queued messages.`);

      while (this.queue.length) {
        const object = this.queue.shift();
        this.sendNow(object); // XXX: should this requeue the message if the transport is unavailable?
        numProcessed++;
      }
    }

    return numProcessed;
  }
}


class JSONSerializer implements ISerializer {
  serialize = JSON.stringify;
  deserialize = JSON.parse;
}


/**
 * Promise representing the response to subscription, and offering an additional
 * cancel() method to stop listening for updates.
 *
 * This is returned from ChannelsApi.subscribe.
 */
class SubscriptionPromise<T> extends Promise<T> {
  _unsubscribe: () => boolean;

  constructor(executor: Function, unsubscribe: () => boolean) {
    super(executor);
    this._unsubscribe = unsubscribe;
  }

  /**
   * Stop listening for new events on this subscription
   * @return true if the subscription was active, false if it was already unsubscribed
   */
  cancel(): boolean {
    return this._unsubscribe();
  }
}


type _SubscriptionDescriptor = {
  selector: Object,
  handler: (payload: Object) => void,
  message: Object,
};


class ChannelsApi implements IStreamingAPI {
  dispatcher: IDispatcher;
  transport: ITransport;
  queue: ISendQueue;
  serializer: ISerializer;

  subscriptions: {[listenerId: number]: _SubscriptionDescriptor};

  /**
   * @param dispatcher Dispatcher instance to route incoming frames to associated handlers
   * @param transport Transport to send and receive messages over the wire.
   * @param queue Instance of Queue to queue messages when transport unavailable.
   * @param serializer Instance which handles serializing data to be sent, and
   *                   deserializing received data.
   */
  constructor(dispatcher: IDispatcher,
              transport: ITransport,
              queue: ISendQueue,
              serializer: ISerializer) {
    this.dispatcher = dispatcher;
    this.transport = transport;
    this.queue = queue;
    this.serializer = serializer;

    this.queue.initialize(this.transport.send, this.transport.isConnected);
    this.subscriptions = {};
  }

  initialize() {
    this.transport.connect();
    this.transport.on('message', this._handleTransportMessage);
    this.transport.on('connect', this._handleTransportConnect);
    this.transport.on('reconnect', this._handleTransportReconnect);
  }

  create(stream: string, props: Object): Promise<Object> {
    return this.request(stream, {
      action: 'create',
      data: props,
    });
  }

  retrieve(stream: string, pk: number): Promise<Object> {
    return this.request(stream, {
      action: 'retrieve',
      pk,
    });
  }

  update(stream: string, pk: number, props: Object): Promise<Object> {
    return this.request(stream, {
      action: 'update',
      pk,
      data: props,
    });
  }

  delete(stream: string, pk: number): Promise<Object> {
    return this.request(stream, {
      action: 'delete',
      pk,
    });
  }

  subscribe(stream: string,
            action: SubscriptionAction,
            pk: ?number | SubscriptionHandler,
            callback?: SubscriptionHandler): SubscriptionPromise<Object> {
    if (typeof pk === 'function') {
      callback = pk;
      pk = null;
    }

    if (callback == null) {
      throw new Error('callback must be provided');
    }

    const selector = this._buildSubscriptionSelector(stream, action, pk);
    const handler = this._buildListener(callback);
    const payload = this._buildSubscribePayload(action, pk);

    const listenerId = this.dispatcher.listen(selector, handler);
    const message = this._buildMultiplexedMessage(stream, payload);
    this.subscriptions[listenerId] = {selector, handler, message};

    const requestPromise = this.request(stream, payload);
    const unsubscribe = this._unsubscribe.bind(this, listenerId);

    return new SubscriptionPromise((resolve, reject) => {
      requestPromise.then(resolve, reject);
    }, unsubscribe);
  }

  /**
   * Send subscription requests for all registered subscriptions
   */
  resubscribe() {
    // With flow, Object.values returns Array<mixed>. To have it return an array
    // of our expected type, we must cast to Array<any> first.
    const subscriptions = Object.values(this.subscriptions);
    const subscriptionsIter = ((subscriptions: Array<any>): Array<_SubscriptionDescriptor>);

    log.info('Resending %d subscription requests', subscriptionsIter.length);

    for (const {message} of subscriptionsIter) {
      this.sendNow(message);
    }
  }

  request(stream: string, payload: Object, requestId: string=UUID.generate()): Promise<Object> {
    return new Promise((resolve, reject) => {
      const selector = this._buildRequestResponseSelector(stream, requestId);

      this.dispatcher.once(selector, data => {
        const {payload: response} = data;
        const {responseStatus} = response;

        // 2xx is success
        if (Math.floor(responseStatus / 100) === 2) {
          resolve(response.data);
        } else {
          reject(response);
        }
      });

      const message = this._buildMultiplexedMessage(stream, Object.assign({}, payload, {requestId}));
      this.send(message);
    });
  }

  send(object: Object) {
    return this._doSend(object, this.queue.send);
  }

  sendNow(object: Object) {
    return this._doSend(object, this.queue.sendNow);
  }

  _doSend(object: Object, send: (bytes: string) => number) {
    const bytes: string = this.serializer.serialize(object);
    return send(bytes);
  }

  _unsubscribe(listenerId: number): boolean {
    // TODO: send unsubscription message (unsupported by channels-api at time of writing)
    const found = this.subscriptions.hasOwnProperty(listenerId);
    if (found) {
      this.dispatcher.cancel(listenerId);
      delete this.subscriptions[listenerId];
    }
    return found;
  }

  @autobind
  _handleTransportMessage(event: MessageEvent) {
    const data = this.serializer.deserialize(event.data);
    return this._handleMessage((data: any));
  }

  _handleMessage(data: Object) {
    this.dispatcher.dispatch(data);
  }

  @autobind
  _handleTransportConnect() {
    log.debug('Initial API connection over transport %s', this.transport);
    this.queue.processQueue();
  }

  @autobind
  _handleTransportReconnect() {
    log.debug('Reestablished API connection');
    this.resubscribe();
    this.queue.processQueue();
  }

  _buildMultiplexedMessage(stream: string, payload: Object) {
    return {stream, payload};
  }

  _buildRequestResponseSelector(stream: string, requestId: string) {
    return {
      stream,
      payload: {requestId},
    };
  }

  _buildSubscribePayload(action: string, pk: ?number) {
    const payload = {
      action: 'subscribe',
      data: {action, pk},
    };

    if (pk == null) {
      delete payload.data.pk;
    }

    return payload;
  }

  _buildSubscriptionSelector(stream: string, action: string, pk: ?number) {
    const selector = {
      stream,
      payload: {action, pk}
    };

    if (pk == null) {
      delete selector.payload.pk;
    }

    return selector;
  }

  /**
   * Build a function which will take an entire JSON message and return only
   * the relevant payload (usually an object).
   * @private
   */
  _buildListener(callback: (data: Object) => void) {
    return function(data: Object) {
      return callback(data.payload.data);
    }
  }
}


module.exports = {
  ChannelsApi,
  SubscriptionPromise,
  FifoQueue,
  BaseSendQueue,
  WebsocketTransport,
  FifoDispatcher,

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
};
