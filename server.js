
// notes:
// implement trimming the pending entries after inactivity
// implement logging

// references
var config = require("config");
var crypto = require("crypto");
var qs = require("querystring");
var promise = require("bluebird");
var express = require("express");
var bodyParser = require("body-parser");
var cookieParser = require("cookie-parser");
var bodyParser = require("body-parser");
var wasb = require("azure-storage");
var fs = require("fs");
var base64 = require("base64-stream");
var stream = require("stream");
var AuthenticationContext = require("adal-node").AuthenticationContext;
var nJwt = require("njwt");

// express config
var app = express();
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static("client"));

// get the configuration
var clientId = config.get("clientId");
var clientSecret = config.get("clientSecret");
var authority = config.get("authority");
var redirectUri = config.get("redirectUri");
var resource = config.get("resource");
var jwtKey = config.get("jwtKey");
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
        case "auth":
            this.status(401).send({ code: 120, msg: "You are not properly authorized to view this page." });
            break;
        case "accounts?":
        case "account?":
        case "container?":
        case "blobs?":
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
        case "account":
            this.status(500).send({ code: 500, msg: "The account cannot be created - please ensure you have specified a valid, unique username." });
            break;
        case "delete-blob":
            this.status(500).send({ code: 500, msg: "The blob could not be deleted, please try again later." });
            break;
        case "delete-account":
            this.status(500).send({ code: 510, msg: "The account could not be deleted, please try again later." });
            break;
        default:
            this.status(500).send({ code: 999, msg: "Unknown error." });
            break;
    }
}

function verifyToken(req) {
    return new promise(function(resolve, reject) {
        try {
            if (req.cookies.accessToken) {
                nJwt.verify(req.cookies.accessToken, jwtKey, function(error, verified) {
                    if (!error) {
                        resolve(verified);
                    } else {
                        console.log("verifyToken: The JWT was not verified successfully - " + error + ".");
                        reject("auth");
                    }
                });
            } else {
                console.log("verifyToken: There was no cookie passed with the JWT for authentication.");
                reject("auth");
            }
        } catch (ex) {
            console.log("verifyToken: There was an exception raised on verification of the JWT - " + ex + ".");
            reject("auth");
        }
    });
}

function verifyAdmin(req) {
    return verifyToken(req).then(function(verified) {
        if (verified.body.scope == "[admin]") {
            return promise.resolve(verified);
        } else {
            console.log("verifyAdmin: The JWT was valid, but the user was not an admin.");
            return promise.reject("auth");
        }
    });
}

// a login with user consent (if the admin has already consented there is no additional consent required)
app.get("/login/admin", function(req, res) {
    crypto.randomBytes(48, function(err, buf) {
    if (err) {
        console.log("login: couldn't generate the crypto token.");
        res.sendError("exception");
    } else {
        var token = buf.toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
        res.cookie("authstate", token, {
            maxAge: 10 * 60 * 1000 // 10 min
        });
        var url = authority + "/oauth2/authorize?response_type=code&client_id=" + qs.escape(clientId) + "&redirect_uri=" + qs.escape(redirectUri) + "&state=" + qs.escape(token) + "&resource=" + qs.escape(resource);
        res.redirect(url);
    }
  });
});

// get an authorization token
app.get("/token", function(req, res) {

    // ensure this is all part of the same authorization chain
    if (req.cookies.authstate !== req.query.state) {
        console.log("token: the state token did not match.");
        res.sendError("auth");
    } else {
      
      // obtain an access token
      var authenticationContext = new AuthenticationContext(authority);
      authenticationContext.acquireTokenWithAuthorizationCode(req.query.code, redirectUri, resource, clientId, clientSecret, function(err, response) {
          if (!err) {

            // build the claims
            var claims = {
                iss: "http://testauth.plasne.com",
                sub: response.userId,
                scope: "[admin]"
            };

            // build the JWT
            var jwt = nJwt.create(claims, jwtKey);
            jwt.setExpiration(new Date().getTime() + (4 * 60 * 60 * 1000)); // 4 hours

            // return the JWT
            res.cookie("accessToken", jwt.compact(), {
                maxAge: 4 * 60 * 60 * 1000 // 4 hours
            });
            res.redirect("/admin.htm");

          } else {
              console.log("token: an authorization token could not be obtained - " + err);
              res.sendError("auth");
          }
      });

    }

});

app.post("/login/account", function(req, res) {
    if (req.body.username && req.body.password) {
        var service = wasb.createTableService(storageAccount, storageKey);
        var create = new promise(function(resolve, reject) {
            try {
                service.createTableIfNotExists("accounts", function(error, result, response) {
                    if (error) {
                        console.log("createTableIfNotExists: " + error);
                        reject("account?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("createTableIfNotExists: " + ex);
                reject("account?");
            }
        });
        var list = new promise(function(resolve, reject) {
            try {
                service.retrieveEntity("accounts", "customers", req.body.username, function(error, result, response) {
                    if (error) {
                        console.log("retrieveEntity: " + error);
                        reject("account?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("retrieveEntity: " + ex);
                reject("account?");
            }
        });
        promise.each([create, list], function(result) { }).then(function(result) {
            var entry = result[1];

            // build the claims
            var claims = {
                iss: "http://testauth.plasne.com",
                sub: entry.RowKey._,
                scope: entry.container._
            };

            // build the JWT
            var jwt = nJwt.create(claims, jwtKey);
            jwt.setExpiration(new Date().getTime() + (24 * 60 * 60 * 1000)); // 24 hours

            // return the JWT
            res.cookie("accessToken", jwt.compact(), {
                maxAge: 24 * 60 * 60 * 1000 // 24 hours
            });
            res.status(200).end();

        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/list/accounts: " + ex);
            res.sendError("exception");
        });
    }
});

// create an account
app.post("/account", function(req, res) {
    if (req.body.username && req.body.password && req.body.container) {
        var service = wasb.createTableService(storageAccount, storageKey);
        var create = new promise(function(resolve, reject) {
            try {
                service.createTableIfNotExists("accounts", function(error, result, response) {
                    if (error) {
                        console.log("createTableIfNotExists: " + error);
                        reject("account?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("createTableIfNotExists: " + ex);
                reject("account?");
            }
        });
        var insert = new promise(function(resolve, reject) {
            try {
                var gen = wasb.TableUtilities.entityGenerator;
                var entity = {
                    "PartitionKey": gen.String("customers"),
                    "RowKey": gen.String(req.body.username),
                    "password": gen.String(req.body.password),
                    "container": gen.String(req.body.container)
                };
                service.insertEntity("accounts", entity, function(error, result, response) {
                    if (error) {
                        console.log("insertEntity: " + error);
                        reject("account");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("insertEntity: " + ex);
                reject("account");
            }
        });
        var ensureContainer = new promise(function(resolve, reject) {
            try {
                var blobservice = wasb.createBlobService(storageAccount, storageKey);
                blobservice.createContainerIfNotExists(req.body.container, function(error, result, response) {
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
        promise.each([verifyAdmin(req), create, insert, ensureContainer], function(result) { }).then(function(result) {
            res.status(200).send(req.body);
        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/create/account: " + ex);
            res.sendError("exception");
        });
    } else {
        res.sendError("malformed");
    }
});

// get a list of accounts
app.get("/accounts", function(req, res) {
    var service = wasb.createTableService(storageAccount, storageKey);
    var create = new promise(function(resolve, reject) {
        try {
            service.createTableIfNotExists("accounts", function(error, result, response) {
                if (error) {
                    console.log("createTableIfNotExists: " + error);
                    reject("accounts?");
                } else {
                    resolve(result);
                }
            });
        } catch (ex) {
            console.log("createTableIfNotExists: " + ex);
            reject("accounts?");
        }
    });
    var list = new promise(function(resolve, reject) {
        try {
            var query = new wasb.TableQuery().top(1000).where("PartitionKey eq ?", "customers");
            service.queryEntities("accounts", query, null, function(error, result, response) {
                if (error) {
                    console.log("queryEntities: " + error);
                    reject("accounts?");
                } else {
                    resolve(result);
                }
            });
        } catch (ex) {
            console.log("queryEntities: " + ex);
            reject("accounts?");
        }
    });
    promise.each([verifyAdmin(req), create, list], function(result) { }).then(function(result) {
        var response = [];
        result[2].entries.forEach(function(entry) {
            response.push({
                "username": entry.RowKey._,
                "password": entry.password._,
                "container": entry.container._
            });
        });
        res.status(200).send(response);
    }, function(error) {
        res.sendError(error);
    }).catch(function(ex) {
        console.log("/list/accounts: " + ex);
        res.sendError("exception");
    });
});

// delete an account
app.delete("/account", function(req, res) {
    if (req.query.username) {
        verifyAdmin(req).then(function(verified) {
            var container = (verified.body.scope == "[admin]") ? req.query.container : verified.body.scope;
            var service = wasb.createTableService(storageAccount, storageKey);
            return new promise(function(resolve, reject) {
                try {
                    var gen = wasb.TableUtilities.entityGenerator;
                    var entity = {
                        "PartitionKey": gen.String("customers"),
                        "RowKey": gen.String(req.query.username)
                    };
                    service.deleteEntity("accounts", entity, function(error, result, response) {
                        if (error) {
                            console.log("deleteEntity: " + error);
                            reject("delete-account");
                        } else {
                            resolve(result);
                        }
                    });
                } catch (ex) {
                    console.log("deleteEntity: " + ex);
                    reject("delete-account");
                }
            })
        }).then(function() {
            res.status(200).end();
        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/account (delete): " + ex);
            res.sendError("exception");
        });
    } else {
        res.sendError("malformed");
    }
});

// get a list of blobs in the specified container
app.get("/blobs", function(req, res) {
    var service = wasb.createBlobService(storageAccount, storageKey);
    var container;
    verifyToken(req).then(function(verified) {
        container = (verified.body.scope == "[admin]") ? req.query.container : verified.body.scope;
        return new promise(function(resolve, reject) {
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
    }).then(function() {
        return new promise(function(resolve, reject) {
            try {
                service.listBlobsSegmented(container, null, {
                    maxResults: 100
                }, function(error, result, response) {
                    if (error) {
                        console.log("listBlobsSegmented: " + error);
                        reject("blobs?");
                    } else {
                        resolve(result);
                    }
                });
            } catch (ex) {
                console.log("listBlobsSegmented: " + ex);
                reject("blobs?");
            }
        });
    }).then(function(result) {
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
        console.log("/blobs: " + ex);
        res.sendError("exception");
    });
});

// get a list of blobs in the specified container
app.get("/blob", function(req, res) {
    if (req.query.name) {
        verifyToken(req).then(function(verified) {
            var container = (verified.body.scope == "[admin]") ? req.query.container : verified.body.scope;
            var service = wasb.createBlobService(storageAccount, storageKey);

            // create a shared access policy
            var startDate = new Date();
            var expiryDate = new Date(startDate);
            startDate.setMinutes(startDate.getMinutes() - 5); // 5 min ago
            expiryDate.setMinutes(startDate.getMinutes() + 240); // 4 hours from now
            var sharedAccessPolicy = {
                AccessPolicy: {
                    Permissions: wasb.BlobUtilities.SharedAccessPermissions.READ,
                    Start: startDate,
                    Expiry: expiryDate
                }
            };

            // redirect to the URL
            var token = service.generateSharedAccessSignature(container, req.query.name, sharedAccessPolicy);
            var sasUrl = service.getUrl(container, req.query.name, token);
            res.redirect(sasUrl);

        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/blob: " + ex);
            res.sendError("exception");
        });
    } else {
        res.sendError("malformed");
    }
});

// delete a blob
app.delete("/blob", function(req, res) {
    if (req.query.name) {
        verifyToken(req).then(function(verified) {
            var container = (verified.body.scope == "[admin]") ? req.query.container : verified.body.scope;
            var service = wasb.createBlobService(storageAccount, storageKey);
            return new promise(function(resolve, reject) {
                try {
                    service.deleteBlob(container, req.query.name, function(error, result, response) {
                        if (error) {
                            console.log("deleteBlob: " + error);
                            reject("delete-blob");
                        } else {
                            resolve(result);
                        }
                    });
                } catch (ex) {
                    console.log("deleteBlob: " + ex);
                    reject("delete-blob");
                }
            })
        }).then(function() {
            res.status(200).end();
        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/blob (delete): " + ex);
            res.sendError("exception");
        });
    } else {
        res.sendError("malformed");
    }
});

// upload all or part of a file
app.post("/upload", function(req, res) {
    if (req.query.name && req.query.cmd && req.query.seq) {
        verifyToken(req).then(function(verified) {
            var container = (verified.body.scope == "[admin]") ? req.query.container : verified.body.scope;
            var overwrite = (req.query.overwrite == "true");
            var file = pending.find(container, req.query.name);
            var decoder = base64.decode();
            switch(req.query.cmd) {

                case "complete":
                    if (!file) {
                        // upload the file
                        pending.add(container, req.query.name, overwrite).then(function(file) {
                            req.pipe(decoder).pipe(file.writer);
                            pending.remove(req.query.container, req.query.name);
                            res.status(200).end();
                        }, function(error) {
                            res.sendError(error);
                        }).catch(function(ex) {
                            console.log("complete: " + ex);
                            res.sendError("exception");
                        });
                    } else {
                        // replace the in-progress upload (implicit replace)
                        file.writer.end();
                        pending.remove(container, req.query.name);
                        pending.add(container, req.query.name, true).then(function(file) {
                            req.pipe(decoder).pipe(file.writer);
                            pending.remove(container, req.query.name);
                            res.status(200).end();
                        }, function(error) {
                            pending.remove(container, req.query.name);
                            res.sendError(error);
                        }).catch(function(ex) {
                            console.log("complete: " + ex);
                            res.sendError("exception");
                        });
                    }
                    break;

                case "begin":
                    if (!file) {
                        // upload the file
                        pending.add(container, req.query.name, overwrite).then(function(file) {
                            req.pipe(decoder).pipe(file.writer, { end: false });
                            file.sequence++;
                            res.status(200).end();
                        }, function(error) {
                            pending.remove(container, req.query.name);
                            res.sendError(error);
                        }).catch(function(ex) {
                            console.log("begin: " + ex);
                            res.sendError("exception");
                        });
                    } else {
                        // resume the in-progress upload (implicit continue)
                        res.status(200).send({
                            "status": "resume",
                            "sequence": file.sequence 
                        });
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
                        pending.remove(container, req.query.name);
                        res.status(200).end();
                    } else if (req.query.seq < file.sequence) {
                        // the request sequence can be lower if it didn't get confirmation of a commit, let it catch up
                        res.status(200).end();
                    } else {
                        res.sendError("out-of-sync");
                    }
                    break;

                case "abort":
                    pending.remove(container, req.query.name);
                    res.status(200).end();
                    break;

            }
        }, function(error) {
            res.sendError(error);
        }).catch(function(ex) {
            console.log("/upload: " + ex);
            res.sendError("exception");
        });
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