import {FifoDispatcher, ChannelsApi} from './channels-api';


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


// TODO: moar tests >_>
