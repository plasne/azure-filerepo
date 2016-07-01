
// notes:
// implement starting a file that was started before
// implement checking for an existing file in the container
// implement logging
// implement configuration file

//var q = require("q");
//var promise = require("bluebird");
var express = require("express");
var bodyParser = require("body-parser");
var wasb = require("azure-storage");
var fs = require("fs");
var base64 = require("base64-stream");
var stream = require("stream");
var profiler = require("v8-profiler");

var app = express();
app.use(express.static("client"));

var _service;

// the current upload queue
var pending = {
    list: [],

    ensureContainer: function(service, container, onSuccess, onFailure) {
        try {
            service.createContainerIfNotExists(container, function(error, result, response) {
                if (error) {
                    if (onFailure) onFailure("container?");
                } else {
                    if (onSuccess) onSuccess();
                }
            });
        } catch (ex) {
            console.log("ensureContainer: " + ex);
            if (onFailure) onFailure("container?");
        }
    },

    canWriteFile: function(service, container, name, overwrite, onSuccess, onFailure) {
        try {
            service.doesBlobExist(container, name, function(error, result, response) {
                if (error) {
                    if (onFailure) onFailure("exists?");
                } else {
                    if (!result.exists || overwrite) {
                        if (onSuccess) onSuccess();
                    } else {
                        if (onFailure) onFailure("exists");
                    }
                }
            });
        } catch (ex) {
            console.log("canWriteFile: " + ex);
            if (onFailure) onFailure("exists?");
        }
    },

    begin: function(service, container, name, onSuccess, onFailure) {
        try {

            // create a writable block blob
            var writer = service.createWriteStreamToBlockBlob(container, name, function(error, result, response) {
                if (!error) {
                    console.log("transferred");
                } else {
                    console.log("failed - " + error);
                }
            });
            writer.on("close", function() {
                console.log("close");
            });
            writer.on("finish", function() {
                console.log("finished"); 
            });

            // create a reference for the file
            var file = {
                container: container,
                name: name,
                sequence: 0,
                writer: writer
            };

            pending.list.push(file);
            if (onSuccess) onSuccess(file); 

        } catch (ex) {
            console.log("begin: " + ex);
            if (onFailure) onFailure("write?");
        }
    },

    add: function(container, name, overwrite, onSuccess, onFailure) {
        var self = this;
        if (_service == null) {
            _service = wasb.createBlobService("2e2115eastus", "1tnb/X2r4VZNMyKOHmM4bJfollRsF1jId2pVAhTitdmszP4MH7kc39pm97ijhHtteRY5EzuDnkIBBz8tP/2CSQ==");
        }
        var service = _service;
        //self.ensureContainer(service, container, function() {
            self.canWriteFile(service, container, name, overwrite, function() {
                self.begin(service, container, name, onSuccess, onFailure);
            }, onFailure);
        //}, onFailure);
    },

    remove: function(container, name) {
        for (var i = 0; i < this.list.length; i++) {
            if (this.list[i].container == container && this.list[i].name == name) {
                this.list.splice(i, 1);
                return;
            }
        }
    },
    
    find: function(container, name) {
        for (var i = 0; i < this.list.length; i++) {
            if (this.list[i].container == container && this.list[i].name == name) return this.list[i];
        }
        return null;
    }
    
};

// hello
app.get("/hello", function(req, res) {
   res.send("hello"); 
});

app.post("/hello", function(req, res) {
   res.send("hello"); 
});

// home page
app.get("/", function(req, res) {
    res.redirect("/index.htm");
});

// extend the response object to include the custom error messages
express.response.sendError = function(error) {
    console.log("error: " + JSON.stringify(error));
    switch(error) {
        case "exception":
            this.status(500).send({ code: 000, msg: "The application raised an exception. Please refresh your browser and try again later or contact the system administrator." });
            break;
        case "malformed":
            this.status(500).send({ code: 100, msg: "The request sent to the server was malformed. Please refresh your browser and try again or contact the system administrator." });
            break;
        case "exists?":
        case "container?":
        case "write?":
            this.status(500).send({ code: 200, msg: "The file repository cannot be accessed right now, please try again later." });
            break;
        case "exists":
            this.status(500).send({ code: 300, msg: "The file already exists, please flag to overwrite the existing file or upload with a different filename." });
            break;
        case "out-of-sync":
            this.status(500).send({ code: 400, msg: "The upload packets were not in the expected order. Please refresh your browser and select the file for upload again." });
            break;
        default:
            this.status(500).send({ code: 999, msg: "Unknown error." });
            break;
    }
}

// upload all or part of a file
app.post("/upload", function(req, res) {
    try {

var time = process.hrtime();
process.nextTick(function() {
    diff = process.hrtime(time);
    var nano = (diff[0] * 1e9 + diff[1]) / 1e6;
    console.log(nano);
});

        if (req.query.container && req.query.name && req.query.cmd && req.query.seq) {
            var overwrite = (req.query.overwrite == "true");
            var file = pending.find(req.query.container, req.query.name);
            var decoder = base64.decode();
            switch(req.query.cmd) {

                case "complete":
                    if (!file) {
                        // upload the file
                        pending.add(req.query.container, req.query.name, overwrite).then(function(file) {
                            req.pipe(decoder).pipe(file.writer);
                            pending.remove(req.query.container, req.query.name);
                            res.status(200).end();
                        }, function(error) {
                            res.sendError(error);
                        });
                    } else {
                        // replace the in-progress upload (implicit replace)
                        file.writer.end();
                        pending.remove(req.query.container, req.query.name);
                        pending.add(req.query.container, req.query.name, true).then(function(file) {
                            req.pipe(decoder).pipe(file.writer);
                            pending.remove(req.query.container, req.query.name);
                            res.status(200).end();
                        }, function(error) {
                            pending.remove(req.query.container, req.query.name);
                            res.sendError(error);
                        });
                    }
                    break;

                case "begin":
                //if (1==3) {
                    if (!file) {
                        // upload the file
                        pending.add(req.query.container, req.query.name, overwrite, function(file) {
                            //req.pipe(decoder).pipe(file.writer, { end: false });
                            //file.sequence++;
                            //res.status(200).end();
                            res.status(501).end();
                        }, function(error) {
                            res.sendError(error);
                        });
                    } else {
                        // resume the in-progress upload (implicit continue)
                        res.status(500).send("implement continue!!!");
                    }
                //}
                //res.status(501).end();
                    break;

                case "continue":
                    if (file.sequence == req.query.seq) {
                        req.pipe(decoder).pipe(file.writer, { end: false });
                        file.sequence++;
                        res.status(200).end();
                    } else if (req.query.seq < file.sequence) {
                        // the request sequence can be lower if it didn't get confirmation of a commit, let it catch up
                        res.status(200).end();
                    } else {
                        res.sendError("out-of-sync");
                    }
                    break;

                case "end":
                    if (file.sequence == req.query.seq) {
                        req.pipe(decoder).pipe(file.writer);
                        pending.remove(req.query.container, req.query.name);
                        res.status(200).end();
                    } else if (req.query.seq < file.sequence) {
                        // the request sequence can be lower if it didn't get confirmation of a commit, let it catch up
                        res.status(200).end();
                    } else {
                        res.sendError("out-of-sync");
                    }
                    break;

                case "abort":
                    pending.remove(req.query.container, req.query.name);
                    res.status(200).end();
                    break;

            }
        } else {
            res.sendError("malformed");
        }
        console.log("done");
    } catch (ex) {
        console.log("exception: " + ex);
        res.sendError("exception");
    }
});

// start the server
var port = process.env.port || 80;
app.listen(port, function() {
   console.log("listening on port " + port + "..."); 
});

//promise.onPossiblyUnhandledRejection(function(error){
//    console.log("error: " + error);
//    throw error;
//});

process.on('unhandledRejection', function(reason, p){
    console.log("Possibly Unhandled Rejection at: Promise ", p, " reason: ", reason);
    // application specific logging here
});

function startProfiling() {
    var id = "profile-" + Date.now();

    // Use stdout directly to bypass eventloop
    fs.writeSync(1, 'Start profiler with Id [' + id + ']\n');

    // Start profiling
    profiler.startProfiling(id);

    // Schedule stop of profiling in x seconds
    setTimeout(function () {
        stopProfiling(id)
    }, 1 * 60 * 1000);

    console.log("profile started");
}

function stopProfiling(id) {
    //var path = "/Users/plasne/Documents";
    var path = "/home/plasne"
    var profile = profiler.stopProfiling(id);
    fs.writeFile(path + '/filerepo/' + id + '.cpuprofile', JSON.stringify(profile), function () {
        console.log('Profiler data written');
    });
}

//setTimeout(startProfiling, 10 * 1000);
