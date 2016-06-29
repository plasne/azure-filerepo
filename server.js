
// notes:
// implement starting a file that was started before
// implement checking for an existing file in the container
// implement logging
// implement configuration file

var q = require("q");
var express = require("express");
var bodyParser = require("body-parser");
var wasb = require("azure-storage");
var fs = require("fs");
var base64 = require("base64-stream");
var stream = require("stream");

var app = express();
app.use(express.static("client"));

// the current upload queue
var pending = {
    list: [],
    
    add: function(container, name, replace) {
        var deferred = q.defer();

        // connect and create the container        
        var service = wasb.createBlobService("2e2115eastus", "1tnb/X2r4VZNMyKOHmM4bJfollRsF1jId2pVAhTitdmszP4MH7kc39pm97ijhHtteRY5EzuDnkIBBz8tP/2CSQ==");
        service.createContainerIfNotExists(container, function(error, result, response) {
            if (!error) {

                // create a function to handle the operations
                var open = function() {

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
                    return file;

                }

                // see if the blob already exists
                service.doesBlobExist(container, name, function(error, result, response) {
                    if (!error) { // file exists
console.log(result);
                        if (result.exists) {
                            console.log("exists");
                            if (replace) {
                                console.log("delete");
                                service.deleteBlob(container, name, function(error) {
                                    if (!error) {
                                        // file exists, but can be replaced
                                        deferred.resolve(open());
                                    } else {
                                        console.log("couldn't delete blob");
                                        deferred.reject("locked");
                                    }
                                });
                            } else {
                                console.log("already exists");
                                deferred.reject("exists");
                            }
                        } else {
                            // file doesn't exist so create
                            console.log("doesn't exist");
                            deferred.resolve(open());
                        }
                    } else {
                        // file doesn't exist so create
                        console.log(error);
                        deferred.reject("exception");
                    }
                });

            } else {
// create container doesn't work
            }
        })

        return deferred.promise;
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
    switch(error) {
        case "malformed":
            this.status(500).send("The request sent to the server was malformed. Plrease refresh your browser and try again or contact the system administrator.");
            break;
        case "exists":
            this.status(500).send("The file already exists, please flag to overwrite the existing file or upload with a different filename.");
            break;
        case "locked":
            this.status(500).send("The file already exists and is locked, please upload with a different filename.");
            break;
        case "out-of-sync":
            this.status(500).send("The upload packets were not in the expected order. Please refresh your browser and select the file for upload again.");
            break;
    }
}

// upload all or part of a file
app.post("/upload", function(req, res) {
    if (req.query.container && req.query.name && req.query.cmd && req.query.seq) {
        var file = pending.find(req.query.container, req.query.name);
        var decoder = base64.decode();
        switch(req.query.cmd) {

            case "complete":
                if (!file) {
                    // upload the file
                    pending.add(req.query.container, req.query.name).then(function(file) {
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
                        res.sendError(error);
                    });
                }
                break;

            case "begin":
                if (!file) {
                    // upload the file
                    pending.add(req.query.container, req.query.name).then(function(file) {
                        req.pipe(decoder).pipe(file.writer, { end: false });
                        file.sequence++;
                        res.status(200).end();
                    }, function(error) {
                        res.sendError(error);
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
