import EventEmitter from 'events';

import {
  ChannelsApi,
  FifoDispatcher,
  FifoQueue,
  JSONSerializer,
} from '../src/channels-api';

import type ITransport from '../src/interface';


describe('FifoDispatcher', function () {
  describe('dispatch', function () {
    it('should call handler when selector is matched', function() {
      const dispatcher = new FifoDispatcher();
      const spy = sinon.spy();
      dispatcher.listen({test: 'unique'}, spy);
      dispatcher.dispatch({test: 'unique'});
      expect(spy).to.have.been.called;
    });

    it('should not call handler when selector is not matched', function() {
      const dispatcher = new FifoDispatcher();
      const spy = sinon.spy();
      dispatcher.listen({test: 'unique'}, spy);
      dispatcher.dispatch({test: 'clearly not unique'});
      expect(spy).not.to.have.been.called;
    });

    it('should match recursively', function() {
      const dispatcher = new FifoDispatcher();
      const spy = sinon.spy();
      dispatcher.listen({down: {the: {rabbit: 'hole'}}}, spy);
      dispatcher.dispatch({down: {the: {rabbit: 'hole'}}});
      expect(spy).to.have.been.called;
    });
  });

  describe('cancel', function () {
    it('should stop calling handler', function () {
      const dispatcher = new FifoDispatcher();
      const spy = sinon.spy();
      const listenerId = dispatcher.listen({test: 'unique'}, spy);
      dispatcher.dispatch({test: 'unique'});
      expect(spy).to.have.been.calledOnce;

      dispatcher.cancel(listenerId);
      dispatcher.dispatch({test: 'unique'});
      expect(spy).to.have.been.calledOnce;
    });
  });

  describe('once', function() {
    it('should call handler when selector is matched only once', function() {
      const dispatcher = new FifoDispatcher();
      const spy = sinon.spy();
      dispatcher.once({test: 'unique'}, spy);

      dispatcher.dispatch({test: 'unique'});
      expect(spy).to.have.been.calledOnce;

      dispatcher.dispatch({test: 'unique'});
      expect(spy).to.have.been.calledOnce;
    });
  });
});


describe('FifoQueue', function() {
  let queue;

  beforeEach(function() {
    const sendNow = sinon.stub();
    const canSend = sinon.stub().returns(true);
    queue = new FifoQueue(sendNow, canSend);
  });

  describe('send', function () {
    it('should send message immediately if canSend() == true', function () {
      queue.send('test');
      expect(queue.sendNow).to.have.been.calledOnce.and.calledWith('test');
    });

    it('should queue message if canSend() == false', function () {
      sinon.spy(queue, 'queueMessage');
      queue.canSend.returns(false);

      queue.send('test');
      expect(queue.sendNow).not.to.have.been.called;
      expect(queue.queueMessage).to.have.been.calledOnce.and.calledWith('test');
    });
  });

  describe('queueMessage', function() {
    it('should push message to queue', function() {
      queue.queueMessage('test');
      expect(queue.queue).to.eql(['test']);
    });
  });

  describe('processQueue', function() {
    it('should send all queued messages immediately', function () {
      queue.queueMessage('test');
      queue.queueMessage('muffin');
      queue.processQueue();

      expect(queue.sendNow)
        .to.have.been.calledTwice
        .and.calledWith('test')
        .and.calledWith('muffin')
    });
  });
});


describe('ChannelsApi', function() {
  let transport: DummyTransport, api;

  class DummyTransport extends EventEmitter implements ITransport {
    send = sinon.spy();
    hasConnected = false;
    connect = sinon.spy(function() {
      this.isConnected.returns(true);
      if (this.hasConnected) {
        this.emit('reconnect');
      } else {
        this.emit('connect');
        this.hasConnected = true;
      }
    });
    disconnect = sinon.spy(function() {
      this.isConnected.returns(false);
    });
    isConnected = sinon.stub().returns(false);
  }

  class DummySerializer implements ISerializer {
    serialize(message: Object) {
      return message;
    }

    deserialize(bytes: string) {
      return bytes;
    }
  }

  beforeEach(function() {
    const dispatcher = new FifoDispatcher();
    transport = new DummyTransport();
    const queue = new FifoQueue();
    const serializer = new DummySerializer();

    api = new ChannelsApi(dispatcher, transport, queue, serializer);
    api.initialize();
  });


  describe('request', function() {
    it('should send request and listen for response', function() {
      const promise = api.request('test', {'key': 'unique'}).then(response => {
        expect(response).to.eql({'response': 'unique'});
      });

      expect(transport.send).to.have.been.calledOnce;
      const msg = transport.send.getCall(0).args[0];
      const stream = msg.stream;
      const requestId = msg.payload.requestId;

      transport.emit('message', {
        data: {
          stream,
          payload: {
            requestId,
            responseStatus: 200,
            data: {response: 'unique'}
          }
        }
      });

      return promise;
    });

    it('should queue request until connected', function () {
      transport.disconnect();
      transport.hasConnected = false;

      api.request('test', {'key': 'unique'});
      expect(transport.send).not.to.have.been.called;

      transport.connect();
      expect(transport.send).to.have.been.calledOnce;
    });
  });


  describe('subscribe', function() {
    it('should call callback on every update', function() {
      const callback = sinon.spy();
      api.subscribe('stream', 'update', callback);

      return new Promise((resolve, reject) => {
        const emitUpdate = (val) => {
          transport.emit('message', {
            data: {
              stream: 'stream',
              payload: {
                action: 'update',
                data: val
              }
            }
          });
        };

        emitUpdate('muffin');
        expect(callback).to.have.been.calledOnce.and.calledWith('muffin');

        emitUpdate('taco');
        expect(callback).to.have.been.calledTwice.and.calledWith('taco');

        resolve();
      });
    });

    it('should resubscribe on reconnect', function () {
      const stream = 'stream';
      const action = 'update';

      const subReqMatch = sinon.match({
        stream,
        payload: {
          action: 'subscribe',
          data: {
            action
          }
        }
      });

      api.subscribe(stream, action, () => {});
      expect(transport.send).to.have.been.calledOnce.and.calledWithMatch(subReqMatch);

      transport.disconnect();
      transport.connect();
      expect(transport.send).to.have.been.calledTwice;
      expect(transport.send.secondCall).to.have.been.calledWithMatch(subReqMatch);
    });

    it('should stop listening on cancel', function () {
      const callback = sinon.spy();
      const subscription = api.subscribe('stream', 'update', callback);

      return new Promise((resolve, reject) => {
        const emitUpdate = (val) => {
          transport.emit('message', {
            data: {
              stream: 'stream',
              payload: {
                action: 'update',
                data: val
              }
            }
          });
        };

        emitUpdate('muffin');
        expect(callback).to.have.been.calledOnce.and.calledWith('muffin');

        subscription.cancel();

        emitUpdate('taco');
        expect(callback).to.have.been.calledOnce;

        resolve();
      });
    });
  });
});
