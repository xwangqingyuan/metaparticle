(function() {
    // libraries
    var jayson = require('jayson');
    var q = require('q');
    var util = require('./metaparticle-util.js')

    // implementation
    // Passed on to jayson, probably can be eliminated
    var handlers = [];
    // Forward reference to the runner implementation
    var runEnvironment;
    // Canonical list of defined services 
    var services = {};

    module.exports.service = function(name, fn) {
        var service = {
            'name': name,
            'subservices': fn.services,
            'replicas': 1,
            'guid': util.makeGUID(),
            'fn': function(args, callback) {
                if (!fn.async) {
                    callback(null, fn.apply(null, args));
                } else {
                    var params = [callback];
                    for (var i = 0; i < args.length; i++) {
                        params.push(args[i]);
                    }
                    fn.fn.apply(null, params);
                }
            }
        }
        services[name] = service;
        handlers[name] = service.fn;
        return service;
    };

    var requestPromise = function(serviceName, shard, data) {
        var host = runEnvironment.getHostname(serviceName, shard);
        console.log("connecting to: " + host)
        var client = jayson.client.http("http://" + host + ":3000");
        var defer = q.defer();
        client.request(serviceName, [data], function(err, response) {
            if (err) {
                console.log("Error contacting " + host + ": " + err);
                defer.reject(err);
            } else {
                defer.resolve(response.result);
            }
        });
        return defer.promise;
    };

    module.exports.spread = function(replicas, computeFn) {
        return module.exports.shard(replicas, function(data) {
            return Math.floor(Math.random() * replicas);
        }, computeFn);
    }

    module.exports.shard = function(shards, shardingFn, computeFn) {
        handlers['compute'] = function(args, callback) {
            callback(null, computeFn.apply(null, args));
        }
        var computeGUID = util.makeGUID();
        return {
            services: {
                'compute': {
                    'name': 'compute',
                    'guid': computeGUID,
                    'fn': computeFn,
                    'replicas': shards
                },
                'shard': {
                    'name': 'shard',
                    'fn': function(data) {
                        return data;
                    },
                    'guid': makeGUID(),
                    'depends': ['compute'],
                    'replicas': 1
                }
            },
            async: true,
            fn: function(callback, data) {
                var shard = shardingFn(data) % shards;
                var serviceName = util.findServiceName(computeGUID, services);
                var promise = requestPromise(serviceName, shard, data);
                promise.then(function(data) {
                    callback(null, data);
                }, function(err) {
                    callback(err, null);
                });
            }
        };
    };

    module.exports.scatter = function(shards, scatterFn, gatherFn) {
        handlers['scatter'] = function(args, callback) {
            callback(null, scatterFn.apply(null, args));
        }
        var scatterGUID = util.makeGUID();
        return {
            services: {
                'scatter': {
                    'name': 'scatter',
                    'guid': scatterGUID,
                    'fn': scatterFn,
                    'replicas': shards
                },
                'gather': {
                    'name': 'gather',
                    'fn': gatherFn,
                    'guid': util.makeGUID(),
                    'depends': ['scatter'],
                    'replicas': 1,
                }
            },
            async: true,
            fn: function(callback, data) {
                var promises = [];
                for (var i = 0; i < shards; i++) {
                    var serviceName = util.findServiceName(scatterGUID, services);
                    promises.push(requestPromise(serviceName, i, data));
                }
                q.all(promises).then(
                    function(data) {
                        callback(null, gatherFn(data));
                    },
                    function(err) {
                        callback(err, null)
                    });
            }
        };
    };

    module.exports.serve = function(runner) {
        runEnvironment = runner;
        if (process.argv[2] == 'serve') {
            console.log(handlers);
            var server = jayson.server(handlers);
            server.http().listen(parseInt(process.argv[3]));
        } else {
            var promise = runner.build();
            promise.then(function() {
                runner.run(services);
            }).done();
        }
    };

    module.exports.print = function() {
        console.log(JSON.stringify(services, null, 4));
    }
}());
