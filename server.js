
// notes:
// implement starting a file that was started before
// implement checking for an existing file in the container
// implement logging
// implement configuration file
// implement some kind of username/password/container

var config = require("config");
var promise = require("bluebird");
var express = require("express");
var bodyParser = require("body-parser");
var wasb = require("azure-storage");
var fs = require("fs");
var base64 = require("base64-stream");
var stream = require("stream");

var app = express();
app.use(express.static("client"));

var storageAccount = config.get("storageAccount");
var storageKey = config.get("storageKey");

// the current upload queue
var pending = {
    list: [],
    
    add: function(container, name, overwrite) {

        // connect to Azure Storage        
        var service = wasb.createBlobService(storageAccount, storageKey);

        // use or create the container
        var ensureContainer = new promise(function(resolve, reject) {
            try {
                service.createContainerIfNotExists(container, function(error, result, response) {
                    if (error) {
                        console.log("createContainerIfNotExists: " + error);
                        reject("container?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("createContainerIfNotExists: " + ex);
                reject("container?");
            }
        });

        // check to see if the blob already exists
        var canWriteFile = new promise(function(resolve, reject) {
            try {
                service.doesBlobExist(container, name, function(error, result, response) {
                    if (error) {
                        console.log("doesBlobExist: " + error);
                        reject("exists?");
                    } else {
                        if (!result.exists || overwrite) {
                            resolve(result);
                        } else {
                            reject("exists");
                        }
                    }
                });
            } catch (ex) {
                console.log("doesBlobExist: " + ex);
                reject("exists?");
            }
        });

        var begin = new promise(function(resolve, reject) {
            try {

                // create a writable block blob
                var writer = service.createWriteStreamToBlockBlob(container, name, function(error, result, response) {
                    if (error) {
                        console.log("createWriteStreamToBlockBlob: " + error);
                    }
                });

                // create a reference for the file
                var file = {
                    container: container,
                    name: name,
                    sequence: 0,
                    writer: writer
                };

                // add to pending list
                pending.list.push(file);
                resolve(file);

            } catch (ex) {
                console.log("createWriteStreamToBlockBlob: " + ex);
                reject("write?");
            }
        });

        // process those actions in serial
        return promise.each([ensureContainer, canWriteFile, begin], function(result) { }).then(function(results) {
            return results[2];
        }, function(error) {
            return promise.reject(error);
        });

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

// home page
app.get("/", function(req, res) {
    res.redirect("/index.htm");
});

// extend the response object to include the custom error messages
express.response.sendError = function(error) {
    console.log("error: " + JSON.stringify(error));
    switch(error) {
        case "exception":
            this.status(500).send({ code: 100, msg: "The application raised an exception. Please refresh your browser and try again later or contact the system administrator." });
            break;
        case "malformed":
            this.status(500).send({ code: 110, msg: "The request sent to the server was malformed. Please refresh your browser and try again or contact the system administrator." });
            break;
        case "container?":
        case "list?":
        case "exists?":
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

// get a list of objects in the server container
app.get("/list", function(req, res) {
    if (req.query.container) {
        var service = wasb.createBlobService(storageAccount, storageKey);
        var list = new promise(function(resolve, reject) {
            try {
                service.listBlobsSegmented(req.query.container, null, {
                    maxResults: 100
                }, function(error, result, response) {
                    if (error) {
                        console.log("listBlobsSegmented: " + error);
                        reject("list?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("listBlobsSegmented: " + ex);
                reject("list?");
            }
        });
        list.then(function(result) {
            var response = [];
            result.entries.forEach(function(entry) {
                response.push({
                    "name": entry.name,
                    "size": entry.contentLength,
                    "ts": entry.lastModified
                });
            });
            res.status(200).send(response);
        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log(ex);
            res.sendError("exception");
        });
    } else {
        res.sendError("malformed");
    }
});

// upload all or part of a file
app.post("/upload", function(req, res) {
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
                    }).catch(function(ex) {
                        console.log(ex);
                        res.sendError("exception");
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
                    }).catch(function(ex) {
                        console.log(ex);
                        res.sendError("exception");
                    });
                }
                break;

            case "begin":
                if (!file) {
                    // upload the file
                    pending.add(req.query.container, req.query.name, overwrite).then(function(file) {
                        req.pipe(decoder).pipe(file.writer, { end: false });
                        file.sequence++;
                        res.status(200).end();
                    }, function(error) {
                        pending.remove(req.query.container, req.query.name);
                        res.sendError(error);
                    }).catch(function(ex) {
                        console.log(ex);
                        res.sendError("exception");
                    });
                } else {
                    // resume the in-progress upload (implicit continue)
                    res.status(500).send("implement continue!!!");
                }
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
});

// start the server
var port = process.env.port || 80;
app.listen(port, function() {
   console.log("listening on port " + port + "..."); 
});

// alert on unhandled rejections
process.on("unhandledRejection", function(reason, p) {
    console.log("Possibly Unhandled Rejection at: Promise ", p, " reason: ", reason);
});