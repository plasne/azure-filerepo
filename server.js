
// notes:
// use SAS for auth
// support stream and auto-resume
// implement starting a file that was started before
// implement checking for an existing file in the container

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
    
    add: function(container, name) {
        
        var service = wasb.createBlobService("2e2115eastus", "1tnb/X2r4VZNMyKOHmM4bJfollRsF1jId2pVAhTitdmszP4MH7kc39pm97ijhHtteRY5EzuDnkIBBz8tP/2CSQ==");
        // create container if necessary
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

        
        var file = {
           container: container,
           name: name,
           sequence: 0,
           writer: writer
        };
        
        this.list.push(file);
        return file;
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

// upload all or part of a file
app.post("/upload", function(req, res) {
    if (req.query.container && req.query.name && req.query.cmd && req.query.seq) {
        var file = pending.find(req.query.container, req.query.name);
        var decoder = base64.decode();
        switch(req.query.cmd) {
            case "complete":
                if (!file) {
                    file = pending.add(req.query.container, req.query.name);
                    req.pipe(decoder).pipe(file.writer);
                    pending.remove(req.query.container, req.query.name);
                    res.status(200).end();
                } else {
                    res.status(500).send("the file already exists.");
                }
                break;
            case "begin":
                if (!file) {
                    file = pending.add(req.query.container, req.query.name);
                    req.pipe(decoder).pipe(file.writer, { end: false });
                    file.sequence++;
                    res.status(200).end();
                } else {
                    res.status(500).send("the file already exists.");
                }
                break;
            case "continue":
                if (file.sequence == req.query.seq) {
                    req.pipe(decoder).pipe(file.writer, { end: false });
                    file.sequence++;
                    res.status(200).end();
                } else {
                    res.status(500).send("expected sequence " + file.sequence + " but received " + req.query.seq + ".");
                }
                break;
            case "end":
                if (file.sequence == req.query.seq) {
                    req.pipe(decoder).pipe(file.writer);
                    pending.remove(req.query.container, req.query.name);
                    res.status(200).end();
                } else {
                    res.status(500).send("expected sequence " + file.sequence + " but received " + req.query.seq + ".");
                }
                break;
            case "abort":
                pending.remove(req.query.container, req.query.name);
                res.status(200).end();
        }
    } else {
        res.status(500).send("you must include all query string parameters.");
    }
});

// start the server
var port = process.env.port || 3000;
app.listen(port, function() {
   console.log("listening on port " + port + "..."); 
});