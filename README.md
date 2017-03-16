# channels-api-client

This package aims to provide a **simple**, **reliable**, and **generic** interface to consume [channels-api](https://github.com/linuxlewis/channels-api) powered WebSocket APIs.


## Features

 - Promises encapsulating the request/response cycle
 - Subscribe to updates with a callback
 - Automatically reconnect when connection is broken (with backoff — thanks to [reconnecting-websocket](https://github.com/pladaria/reconnecting-websocket))
 - Automatically restart subscriptions on reconnection
 - Requests are queued until a connection is made (no need to wait for connection before sending requests)


## Install

TODO


## Usage

```javascript
const channels_api = require('channels-api');
const client = channels_api.connect('wss://example.com');

client.create('people', {name: 'Alex'}).then(person => {
  console.info('Created:', person);
});

client.retrieve('people', 4).then(person => {
  console.info('Retrieved person 4:', person);
});

client.update('people', 4, {name: 'Johannes'}).then(person => {
  console.info('Changed name of person 4. Properties after change:', person);
});

client.delete('people', 4).then(() => {
  console.info('Deleted person 4. No one liked them, anyway :)');
});


// Subscribe to updates to any person
const subscription = client.subscribe('people', 'update', person => {
  console.info('A person was updated:', person);
});

// Stop listening for updates
subscription.cancel();


// Subscribe to updates to person 1
const personalSubscription = client.subscribe('people', 'update', 1, person => {
  console.info('Person 1 was updated:', person);
});

// Stop listening
personalSubscription.cancel();


// Make a generic request to a multiplexer stream
client.request('mystream', {key: 'value'}).then(response => {
  console.info('Got mystream response, yo:', response);
});
```
