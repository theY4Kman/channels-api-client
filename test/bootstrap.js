import chai from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

chai.use(sinonChai);

global.expect = chai.expect;
global.sinon = sinon;
