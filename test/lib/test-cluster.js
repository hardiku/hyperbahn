// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

/* eslint no-console:0 no-process-env:0 */
/* eslint max-statements: [2, 40] */
var console = require('console');
var process = require('process');
var fs = require('fs');
var timers = require('timers');

var collectParallel = require('collect-parallel/array');
var CountedReadySignal = require('ready-signal/counted');
var EventEmitter = require('events').EventEmitter;
var tape = require('tape');
var deepExtend = require('deep-extend');
var shallowExtend = require('xtend');
var TChannel = require('tchannel');
var DebugLogtron = require('debug-logtron');
var inherits = require('util').inherits;
var nodeAssert = require('assert');
var TChannelJSON = require('tchannel/as/json');
var tapeCluster = require('tape-cluster');
var extend = require('xtend');
var NullStatsd = require('uber-statsd-client/null');

var TCReporter = require('tchannel/tcollector/reporter');
var loadTChannelTestConfig = require('tchannel/test/lib/load_config.js');
var FakeTCollector = require('./fake-tcollector');
var TestApplication = require('./test-app.js');
var RemoteConfigFile = require('./remote-config-file.js');
var CollapsedAssert = require('./collapsed-assert.js');

var channelTestConfigOverlay = null;
if (process.env.TCHANNEL_TEST_CONFIG) {
    channelTestConfigOverlay = loadTChannelTestConfig(process.env.TCHANNEL_TEST_CONFIG);
    JSON.stringify(channelTestConfigOverlay, null, 4)
        .split('\n')
        .forEach(function each(line, i) {
            if (i === 0) {
                console.log(
                    '# TestCluster using test channel config overlay from %s: %s',
                    process.env.TCHANNEL_TEST_CONFIG,
                    line);
            } else {
                console.log('# %s', line);
            }
        });
}

var remoteConfigOverlay = null;
if (process.env.HYPERBAHN_REMOTE_TEST_CONFIG) {
    remoteConfigOverlay = loadTChannelTestConfig(process.env.HYPERBAHN_REMOTE_TEST_CONFIG);
    JSON.stringify(channelTestConfigOverlay, null, 4)
        .split('\n')
        .forEach(function each(line, i) {
            if (i === 0) {
                console.log(
                    '# TestCluster using remote config overlay from %s: %s',
                    process.env.TCHANNEL_TEST_CONFIG,
                    line);
            } else {
                console.log('# %s', line);
            }
        });
}

TestCluster.test = tapeCluster(tape, TestCluster);

module.exports = TestCluster;

/*eslint complexity: [2, 25] */
function TestCluster(opts) {
    if (!(this instanceof TestCluster)) {
        return new TestCluster(opts);
    }

    var self = this;
    EventEmitter.call(self);

    self.opts = opts || {};
    self.size = self.opts.size || 2;
    self.dummySize = self.opts.dummySize || 2;
    self.namedRemotesConfig = self.opts.namedRemotes || [];
    self.remotesConfig = self.opts.remotes || {};

    var defaultKValue = self.size <= 20 ?
        Math.floor(self.size / 2) : 10;

    if (defaultKValue < 1) {
        defaultKValue = 1;
    }

    self.kValue = typeof opts.kValue === 'number' ?
        opts.kValue : defaultKValue;

    opts.remoteConfig = opts.remoteConfig || {};
    opts.remoteConfig['kValue.default'] =
        opts.remoteConfig['kValue.default'] || self.kValue;

    // These are a ring of Hyperbahn apps
    self.apps = [];
    // These are empty TChannel instances, which are not used for new tests
    // since we have remotes.
    self.dummies = [];
    // The hostPorts for each member of the ring.
    self.hostPortList = [];
    self.ringpopHosts = self.hostPortList;

    // Bob and Steve
    self.remotes = {};
    // Names of additional remotes (from opts.namedRemotes)
    self.namedRemotes = [];

    self.timers = null; // Set whenever a channel is created

    self.tchannelJSON = TChannelJSON();
    self.logger = DebugLogtron('autobahn');
    self.statsd = opts.noStats ? null : NullStatsd(opts.statsdSize || 5);

    if (self.opts.whitelist) {
        for (var i = 0; i < self.opts.whitelist.length; i++) {
            self.logger.whitelist(
                self.opts.whitelist[i][0], self.opts.whitelist[i][1]
            );
        }
    }

    self.logger.whitelist('info', 'implementing affinity change');
    self.logger.whitelist('info', 'connecting peers');
}
inherits(TestCluster, EventEmitter);

TestCluster.prototype.bootstrap = function bootstrap(cb) {
    var self = this;

    self.grow(self.size, onRingpopReady);

    function onRingpopReady(err) {
        if (err) {
            cb(err);
            return;
        }

        // bob and steve
        var ready = CountedReadySignal(self.dummySize);
        ready(onReady);
        for (var i = 0; i < self.dummySize; i++) {
            self.dummies[i] = self.createDummy(ready.signal);
        }
    }

    function onReady() {
        if (!self.opts.noTCollector) {
            self.remotes.tcollector = self.createRemote({
                serviceName: 'tcollector',
                trace: false
            }, onTCollectorReady);
        } else {
            onTCollectorReady();
        }
    }

    function onTCollectorReady() {
        if (self.remotes.tcollector) {
            self.tcollector = FakeTCollector({
                channel: self.remotes.tcollector.serverChannel
            });
        }

        var remotesDone = CountedReadySignal(
            2 + self.namedRemotesConfig.length
        );

        remotesDone(onRemotes);

        if (!self.opts.noBob) {
            self.remotes.bob = self.createRemote({
                serviceName: 'bob',
                trace: self.opts.trace,
                traceSample: 1
            }, remotesDone.signal);
        } else {
            remotesDone.signal();
        }

        if (!self.opts.noSteve) {
            self.remotes.steve = self.createRemote({
                serviceName: 'steve',
                trace: self.opts.trace,
                traceSample: 1
            }, remotesDone.signal);
        } else {
            remotesDone.signal();
        }

        for (var i = 0; i < self.namedRemotesConfig.length; i++) {
            var serviceName = self.namedRemotesConfig[i];
            self.namedRemotes[i] = self.createRemote({
                serviceName: serviceName,
                remotesConfig: self.remotesConfig[serviceName],
                trace: self.opts.trace,
                traceSample: 1
            }, remotesDone.signal);
        }
    }

    function onRemotes() {
        if (process.env.DEBUG_TEST) {
            self.forEachHostPort(function each(name, i, hp) {
                name = name.toUpperCase() + i;
                console.error('TEST SETUP: ' + name + ' ' + hp);
            });
        }

        self.emit('listening');
        cb();
    }
};

TestCluster.prototype.grow =
function grow(n, callback) {
    var self = this;

    var newApps = createApps();

    collectParallel(newApps, partialBootstrapEach, partialBootstrapsDone);

    function createApps() {
        var apps = [];
        var i = self.apps.length;
        var j = 0;
        for (; j < n; i++, j++) {
            var app = self.createApplication('127.0.0.1:0', null);
            app.clusterAppsIndex = i;
            self.apps[i] = app;
            apps.push(app);
        }
        return apps;
    }

    function partialBootstrapEach(app, _, done) {
        app.partialBootstrap(function bootstrapped(err) {
            if (err) {
                done(err);
                return;
            }
            self.hostPortList[app.clusterAppsIndex] = app.hostPort;
            done(null);
        });
    }

    function partialBootstrapsDone(_, results) {
        for (var i = 0; i < results.length; i++) {
            var res = results[i];
            if (res.err) {
                callback(res.err);
                return;
            }
        }
        collectParallel(newApps, finishEachBootstrap, bootstrapFinished);
    }

    function finishEachBootstrap(app, _, done) {
        app.clients.autobahnHostPortList = self.hostPortList;
        app.clients.setupRingpop(done);
    }

    function bootstrapFinished(_, results) {
        for (var i = 0; i < results.length; i++) {
            var res = results[i];
            if (res.err) {
                callback(res.err);
                return;
            }
        }
        self.waitForRingpop(callback);
    }
};

TestCluster.prototype.createRemote = function createRemote(opts, cb) {
    var self = this;

    var remote = new TestClusterRemote(self, opts, ready);
    this.timers = remote.channel.timers;
    return remote;

    function ready(err) {
        if (err) {
            self.logger.error('Failed to initialize remote', {
                    error: err
            });
            return;
        }
        cb();
    }
};

TestCluster.prototype.waitForRingpop = function waitForRingpop(cb) {
    var self = this;

    if (self.isRingpopConverged()) {
        return cb();
    }

    var ringpops = self.apps.map(function getRing(x) {
        return x.clients.ringpop;
    });
    ringpops.map(function addListener(ringpop) {
        ringpop.ring.on('checksumComputed', checkAgain);
    });

    function checkAgain() {
        if (!self.isRingpopConverged()) {
            return null;
        }

        ringpops.forEach(function remove(ringpop) {
            ringpop.removeListener('checksumComputed', checkAgain);
        });
        cb();
    }
};

TestCluster.prototype.isRingpopConverged = function isRingpopConverged() {
    var self = this;

    var ringpops = self.apps.map(function getRing(x) {
        return x.clients.ringpop;
    });

    var allHosts = ringpops.map(function getHosts(r) {
        return Object.keys(r.ring.servers);
    });

    var converged = allHosts.every(function checkHosts(ringHosts) {
        // Must be same length
        if (ringHosts.length !== self.hostPortList.length) {
            return false;
        }

        ringHosts.sort();
        self.hostPortList.sort();

        return ringHosts.every(function checkItem(hostPort, i) {
            return self.hostPortList[i] === hostPort;
        });
    });

    return converged;
};

TestCluster.prototype.close = function close(cb) {
    var self = this;
    var i = 0;
    for (i = 0; i < self.apps.length; i++) {
        self.apps[i].destroy();
        if (self.apps[i].remoteConfigFile) {
            self.apps[i].remoteConfigFile.clear();
        }
    }
    for (i = 0; i < self.dummies.length; i++) {
        var dummy = self.dummies[i];
        if (!dummy.destroyed) {
            dummy.close();
        }
    }

    if (self.remotes.steve) {
        self.remotes.steve.destroy();
    }
    if (self.remotes.bob) {
        self.remotes.bob.destroy();
    }
    if (self.remotes.tcollector) {
        self.remotes.tcollector.destroy();
    }

    for (i = 0; i < self.namedRemotes.length; i++) {
        self.namedRemotes[i].destroy();
    }

    cb();
};

TestCluster.prototype.createApplication =
function createApplication(hostPort, bootFile) {
    var self = this;

    if (bootFile === undefined) {
        bootFile = self.ringpopHosts;
    }

    var parts = hostPort.split(':');
    var host = parts[0];
    var port = Number(parts[1]);

    var localOpts = shallowExtend(self.opts);
    localOpts.seedConfig = deepExtend(localOpts.seedConfig || {}, {
        'tchannel.host': host,
        'hyperbahn.ringpop.bootstrapFile': bootFile
    });
    localOpts.argv = {
        port: port
    };

    var rateLimiterBuckets;
    var remoteConfigFile;
    var defaultTotalKillSwitchBuffer;

    self.opts.remoteConfig = self.opts.remoteConfig || {};
    if (remoteConfigOverlay) {
        self.opts.remoteConfig = extend(remoteConfigOverlay, self.opts.remoteConfig);
    }

    if (self.opts.remoteConfig) {
        remoteConfigFile = RemoteConfigFile(hostPort);
        remoteConfigFile.write(self.opts.remoteConfig);
        localOpts.seedConfig = deepExtend(localOpts.seedConfig, {
            'clients.remote-config.file': remoteConfigFile.filePath
        });
        rateLimiterBuckets = self.opts.remoteConfig['rateLimiting.rateLimiterBuckets'];
        defaultTotalKillSwitchBuffer = self.opts.remoteConfig['rateLimiting.defaultTotalKillSwitchBuffer'];
    }

    localOpts.channelTestConfigOverlay = channelTestConfigOverlay;
    localOpts.clients = localOpts.clients || {};
    localOpts.clients.logger =
        localOpts.clients.logger || self.logger;
    localOpts.clients.statsd =
        localOpts.clients.statsd || self.statsd;
    localOpts.rateLimiterBuckets = rateLimiterBuckets;
    localOpts.defaultTotalKillSwitchBuffer = defaultTotalKillSwitchBuffer;

    // TODO throw an error if listen() fails
    // TODO add timeout to gaurd against this edge case
    var app = TestApplication(localOpts);
    app.remoteConfigFile = remoteConfigFile;
    return app;
};

TestCluster.prototype.createDummy = function createDummy(cb) {
    var self = this;
    var dummy = TChannel({
        logger: self.logger,
        traceSample: 1
    });
    dummy.on('listening', cb);
    dummy.listen(0, '127.0.0.1');
    return dummy;
};

TestCluster.prototype.checkExitKValue = function checkExitKValue(assert, opts) {
    nodeAssert(opts && opts.serviceName, 'serviceName required');
    nodeAssert(opts && opts.kValue, 'kValue required');

    var self = this;

    var app = self.apps[0];
    var exitShard = app.clients.egressNodes
        .exitsFor(opts.serviceName);

    var shardKeys = Object.keys(exitShard)
        .reduce(function concatBuilder(acc, key) {
            return acc.concat(exitShard[key]);
        }, []);

    assert.equal(shardKeys.length, opts.kValue,
        'exitNode has kValue number of keys');

    self.apps.forEach(function checkApp(localApp) {
        var localExitShard = localApp.clients.egressNodes
            .exitsFor(opts.serviceName);
        assert.deepEqual(
            localExitShard,
            exitShard,
            'cluster application has same shards as everyone else'
        );
    });
};

TestCluster.prototype.untilExitsConnected =
function untilExitsConnected(serviceName, channel, callback) {
    var self = this;
    self.untilExitsConnectedExcept(serviceName, channel, {}, callback);
};

TestCluster.prototype.untilExitsConnectedExcept =
function untilExitsConnectedExcept(serviceName, channel, except, callback) {
    var self = this;

    var app = self.apps[0];

    var exits = app.clients.egressNodes.exitsFor(serviceName);
    var exitKeys = Object.keys(exits);
    var pending = {};
    for (var i = 0; i < exitKeys.length; ++i) {
        var exitKey = exitKeys[i];
        if (!except[exitKey]) {
            pending[exitKey] = true;
        }
    }

    // Check for all future connections
    channel.connectionEvent.on(onConn);

    // Check for all existing non-identified connections
    forEachServerConn(channel, function each(connection) {
        if (!connection.remoteName) {
            connection.identifiedEvent.on(checkConns);
        }
    });

    checkConns();

    function onConn(conn) {
        conn.identifiedEvent.on(checkConns);
    }

    function checkConns(idInfo, newConn) {
        if (newConn) {
            newConn.identifiedEvent.removeListener(checkConns);
        }

        forEachPeerConn(channel, function each(conn, peer) {
            if (exits[peer.hostPort] !== undefined && conn.direction === 'in') {
                delete pending[peer.hostPort];
            }
        });

        if (!Object.keys(pending).length) {
            finish();
        }
    }

    function finish() {
        channel.connectionEvent.removeListener(onConn);
        callback();
    }
};

TestCluster.prototype.untilExitsDisconnected =
function untilExitsDisconnected(serviceName, channel, callback) {
    var self = this;

    var app = self.apps[0];
    var exits = app.clients.egressNodes.exitsFor(serviceName);
    var count = 1;

    var peers = channel.peers.values();
    for (var i = 0; i < peers.length; i++) {
        var peer = peers[i];
        for (var j = 0; j < peer.connections.length; j++) {
            if (exits[peer.hostPort]) {
                count++;
                waitForClose(peer.connections[j], onConnClose);
            }
        }
    }

    timers.setImmediate(onConnClose);

    function onConnClose() {
        if (--count <= 0) {
            callback(null);
        }
    }

    function waitForClose(conn, listener) {
        var done = false;

        conn.errorEvent.on(onEvent);
        conn.closeEvent.on(onEvent);

        function onEvent() {
            if (!done) {
                done = true;
                listener(conn);
            }
        }
    }
};

TestCluster.prototype.checkExitPeers =
function checkExitPeers(assert, opts) {
    nodeAssert(opts && opts.serviceName, 'serviceName required');
    nodeAssert(opts && opts.hostPort, 'hostPort required');

    var cassert = CollapsedAssert();

    var self = this;
    var app = self.apps[0];

    var exitShard = app.clients.egressNodes
        .exitsFor(opts.serviceName);

    var exitApps = self.apps.filter(function isExit(someApp) {
        return !!exitShard[someApp.tchannel.hostPort];
    });

    if (opts.blackList) {
        exitApps = exitApps.filter(function isNotBlackListed(someApp) {
            return opts.blackList.indexOf(someApp.hostPort) === -1;
        });
    }

    exitApps.forEach(function checkApp(exitApp, i) {
        cassert.comment('--- check peers for exitApp[' + i + ']');
        exitApp.checkExitPeers(cassert, opts);
    });

    cassert.report(assert, 'exit peers are correct for ' + opts.serviceName);
};

TestCluster.prototype.getExitNodes = function getExitNodes(serviceName) {
    var self = this;

    var app = self.apps[0];
    var ringpop = app.clients.ringpop;
    var hosts = [];

    for (var i = 0; i < self.kValue; i++) {
        var hp = ringpop.lookup(serviceName + '~' + i);
        if (hosts.indexOf(hp) === -1) {
            hosts.push(hp);
        }
    }

    var exitApps = [];
    for (var j = 0; j < self.apps.length; j++) {
        if (hosts.indexOf(self.apps[j].hostPort) > -1) {
            exitApps.push(self.apps[j]);
        }
    }

    return exitApps;
};

TestCluster.prototype.sendRegister =
function sendRegister(channel, opts, cb) {
    var self = this;
    self.sendHyperbahn(channel, opts, 'ad', null, {
        services: [{
            cost: 0,
            serviceName: opts.serviceName
        }]
    }, cb);
};

TestCluster.prototype.sendUnregister =
function sendDeregister(channel, opts, cb) {
    var self = this;
    self.sendHyperbahn(channel, opts, 'unad', null, {
        services: [{
            serviceName: opts.serviceName
        }]
    }, cb);
};

/*eslint max-params: [2, 6]*/
TestCluster.prototype.sendHyperbahn =
function sendHyperbahn(channel, opts, arg1, arg2, arg3, cb) {
    var self = this;

    nodeAssert(opts.serviceName, 'need a serviceName to call hyperbahn');

    var hyperChan;
    if (channel.subChannels.hyperbahn) {
        hyperChan = channel.subChannels.hyperbahn;
    } else if (!channel.subChannels.hyperbahn) {
        hyperChan = channel.makeSubChannel({
            serviceName: 'hyperbahn',
            peers: self.hostPortList
        });
    }

    if (opts.host) {
        channel.waitForIdentified({
            host: opts.host
        }, send);
    } else {
        send();
    }

    function send(err) {
        if (err) {
            return cb(err);
        }

        self.tchannelJSON.send(hyperChan.request({
            serviceName: 'hyperbahn',
            host: opts.host,
            hasNoParent: true,
            trace: false,
            timeout: opts.timeout || 5000,
            retryFlags: {
                never: true
            },
            headers: {
                'cn': opts.serviceName
            }
        }), arg1, arg2, arg3, cb);
    }
};

TestCluster.prototype.forEachHostPort =
function forEachHostPort(each) {
    var self = this;
    var i;

    for (i = 0; i < self.hostPortList.length; i++) {
        each('relay', i, self.hostPortList[i]);
    }

    for (i = 0; i < self.dummies.length; i++) {
        each('dummy', i, self.dummies[i].hostPort);
    }

    var remoteNames = Object.keys(self.remotes);
    for (i = 0; i < remoteNames.length; i++) {
        each(remoteNames[i], 0, self.remotes[remoteNames[i]].hostPort);
    }

    for (i = 0; i < self.namedRemotes.length; i++) {
        each('namedRemote', i, self.namedRemotes[i].hostPort);
    }
};

function forEachServerConn(channel, each) {
    var keys = Object.keys(channel.serverConnections);
    for (var i = 0; i < keys.length; i++) {
        var conn = channel.serverConnections[keys[i]];
        each(conn);
    }
}

function forEachPeerConn(channel, each) {
    var peers = channel.peers.values();
    for (var i = 0; i < peers.length; i++) {
        var peer = peers[i];
        for (var j = 0; j < peer.connections.length; j++) {
            var conn = peer.connections[j];
            each(conn, peer);
        }
    }
}

function TestClusterRemote(cluster, opts, ready) {
    var self = this;

    this.cluster = cluster;
    this.opts = opts;
    this.ready = ready;

    this.serviceName = this.opts.serviceName;
    this.serviceConfig = this.cluster.remotesConfig[this.serviceName];

    this.channel = TChannel({
        logger: this.cluster.logger,
        trace: this.opts.trace,
        traceSample: this.opts.traceSample
    });

    this.clientChannel = this.channel.makeSubChannel({
        serviceName: 'autobahn-client',
        peers: this.cluster.hostPortList,
        requestDefaults: {
            hasNoParent: true,
            headers: {
                as: 'raw',
                cn: this.serviceName
            }
        }
    });

    this.serverChannel = this.channel.makeSubChannel({
        serviceName: this.serviceName
    });

    this.hostPort = null;
    this.registerEveryInterval = 0;
    this.registerTimer = null;

    this.thriftSpec = null;
    this.thriftSource = null;
    this.thriftServer = null;
    this.thriftClient = null;

    if (this.serviceConfig) {
        this.thriftSpec = this.serviceConfig.thriftSpec;
    }

    if (this.opts.trace) {
        var tcreporter = TCReporter({
            callerName: 'tcollector-' + this.serviceName,
            logger: this.cluster.logger,
            channel: this.channel.makeSubChannel({
                peers: this.cluster.hostPortList,
                serviceName: 'tcollector-client'
            })
        });
        this.channel.tracer.reporter = function reporter(span) {
            tcreporter.report(span);
        };
    }

    if (this.thriftSpec) {
        this.thriftSource = fs.readFileSync(this.thriftSpec).toString();

        this.thriftServer = this.channel.TChannelAsThrift({
            source: this.thriftSource,
            channel: this.serverChannel
        });

        this.thriftClient = this.channel.TChannelAsThrift({
            source: this.thriftSource,
            channel: this.clientChannel
        });
    } else {
        this.serverChannel.register('echo', echo);
    }

    this.boundDoRegister = boundDoRegister;
    this.boundOnRegister = boundOnRegister;

    this.firstRegistration = true;

    this.channel.listeningEvent.on(onListen);

    function onListen() {
        self.channel.listeningEvent.removeListener(onListen);
        self.hostPort = self.channel.hostPort;
        self.doRegister();
    }

    this.channel.listen(0, '127.0.0.1');

    function boundDoRegister() {
        self.doRegister();
    }

    function boundOnRegister(err, res) {
        self.onRegister(err, res);
    }
}

TestClusterRemote.prototype.destroy =
function destroy(cb) {
    timers.clearTimeout(this.registerTimer);
    this.registerTimer = null;
    if (!this.channel.destroyed) {
        this.channel.close(cb);
    } else if (cb) {
        cb();
    }
};

TestClusterRemote.prototype.registerEvery =
function registerEvery(interval) {
    this.registerEveryInterval = interval;
    timers.clearTimeout(this.registerTimer);
    this.registerTimer = timers.setTimeout(this.boundDoRegister, this.registerEveryInterval);
};

TestClusterRemote.prototype.doRegister =
function doRegister() {
    timers.clearTimeout(this.registerTimer);
    this.registerTimer = null;
    if (!this.channel.destroyed) {
        this.cluster.sendRegister(this.channel, {
            serviceName: this.serviceName
        }, this.boundOnRegister);
    }
};

TestClusterRemote.prototype.doUnregister =
function doUnregister(cb) {
    timers.clearTimeout(this.registerTimer);
    this.registerTimer = null;
    if (!this.channel.destroyed) {
        this.cluster.sendUnregister(this.channel, {
            serviceName: this.serviceName
        }, cb);
    }
};

TestClusterRemote.prototype.onRegister =
function onRegister(err, res) {
    if (err) {
        if (this.firstRegistration) {
            this.ready(err);
            return;
        }
        this.cluster.logger.error('Failed to register to hyperbahn for remote', {
            error: err
        });
    }

    if (this.firstRegistration) {
        this.firstRegistration = false;
        if (this.opts.registerEvery) {
            this.registerEvery(this.opts.registerEvery);
        }
        this.cluster.untilExitsConnected(this.serviceName, this.channel, this.ready);
        return;
    }

    this.registerTimer = timers.setTimeout(this.boundDoRegister, this.registerEveryInterval);
};

function echo(req, res, a, b) {
    res.headers.as = 'raw';
    res.sendOk(String(a), String(b));
}
