
var blockSize = 200000; // in bytes
var retryFor = 30 * 60 * 1000 // in ms, current is 30 min
var filesLocal = [];
var filesServer = [];
var container;

function getQuerystring(key, default_)
{
    if (default_==null) default_="";
    key = key.replace(/[\[]/,"\\\[").replace(/[\]]/,"\\\]");
    var regex = new RegExp("[\\?&]"+key+"=([^&#]*)");
    var qs = regex.exec(window.location.href);
    if (qs == null) {
        return default_;
    } else {
        return qs[1];
    }
}

function dragged(e) {
    $("#file-drop").removeClass("no-hover").addClass("hover");
    return false;
}

function undragged(e) {
    $("#file-drop").removeClass("hover").addClass("no-hover");
    return false;
}

function fileSize(size) {
    if (size > 1000000000) {
        return (size / 1000000000).toFixed(2) + " GB";
    } else if (size > 1000000) {
        return (size / 1000000).toFixed(2) + " MB";
    } else if (size > 1000) {
        return (size / 1000).toFixed(2) + " KB";
    } else {
        return size + " B";
    }
}

function renderLocal() {
    
    // render the file list
    var table = $("#files-local");
    $("tr", table).each(function(i, tr) {
        if (i > 1) $(tr).remove();
    });
    $(filesLocal).each(function(i, file) {
        var tr = $("<tr></tr>").appendTo(table);
        $("<td></td>").appendTo(tr).text(file.name);
        $("<td></td>").appendTo(tr).text(fileSize(file.size));
        var status = (file.status) ? file.status : "";
        $("<td></td>").appendTo(tr).text(status);
    });

    // show or hide the upload button
    if (filesLocal.length > 0) {
        $("#file-upload").show();
    } else {
        $("#file-upload").hide();
    }
    
}

function renderServer() {
    
    // render the file list
    var table = $("#files-server");
    $("tr", table).each(function(i, tr) {
        if (i > 1) $(tr).remove();
    });
    $(filesServer).each(function(i, file) {
        var tr = $("<tr></tr>").appendTo(table);
        var filename = $("<td></td>").appendTo(tr);
        var add = (container) ? "&container=" + container : "";
        $("<a />").appendTo(filename).text(file.name).attr({
            "href": "/blob?name=" + file.name + add,
            "target": "_blank"
        });
        $("<td></td>").appendTo(tr).text(fileSize(file.size));
        $("<td></td>").appendTo(tr).text(file.ts);
        var actions = $("<td></td>").appendTo(tr);
        $("<a>delete</a>").appendTo(actions).attr({
            "href": "#"
        }).click(function() {
            $.ajax({
                type: "DELETE",
                url: "/blob?name=" + file.name + add,
                success: function() {
                    $("#file-status").text(file.name + " deleted successfully.");
                    refresh();
                },
                error: function(xhr, status, error) {
                    $("#file-status").text("Could not delete, please try again later.");
                }
            });
        });
    });

}

function existsInList(name) {
    var found = false;
    $(filesLocal).each(function(i, file) {
        if (file.name == name) found = true;
    });
    return found;
}

function dropped(e) {
    e.stopPropagation();
    e.preventDefault();
    $(e.dataTransfer.files).each(function(i, file) {
        if (!existsInList(file.name)) filesLocal.push(file);
    });
    renderLocal();
}

function selected(e) {
    var selected = $("#file-browser").get(0).files;
    $(selected).each(function(i, file) {
        if (!existsInList(file.name)) filesLocal.push(file);
    });
    renderLocal();
}

function logout() {
    $.cookie("accessToken", null, { path: "/", expires: -1 });
    window.location.href = "/index.htm";
}

function login() {
    var username = $("#file-username").val();
    var password = $("#file-password").val();
    if (username && password) {
        $.ajax({
            type: "POST",
            url: "/login/account",
            contentType: "application/json",
            data: JSON.stringify({
                "username": username,
                "password": password,
            }),
            success: function() {
                $("#file-login").hide();
                $("#file-interface").show();
                refresh();
            },
            error: function(xhr, status, error) {
                $("#file-status").text("Could not login, please verify your username/password or try again later.");
            }
        });
    } else {
        $("#file-status").text("Please provide a username and password to login.");
    }
}

function refresh() {
    var add = (container) ? "?container=" + container : "";
    $.ajax({
        type: "GET",
        url: "/blobs" + add,
        success: function(entries) {
            filesServer = entries;
            renderServer();
        },
        error: function(xhr, status, error) {
            filesServer = [];
            renderServer();
            $("#file-status").text("Could not get a list of files from the server.");
        }
    });
}

function upload() {

    // transfer the first file
    if (filesLocal.length > 0) {
        var file = filesLocal[0];
        
        // transfer from the beginning of the file
        var cmd = "begin";
        var cursor = 0;
        var parts = Math.ceil(file.size / blockSize);
        var started = new Date();
        var retrySince = null;
        
        // read a block of data
        var read = function() {
            
            // determine the position of the block for the read
            if (cursor > 0) cmd = "continue";
            var start = cursor * blockSize;
            var stop = (cursor + 1) * blockSize;
            if (stop >= file.size) {
                stop = file.size;
                cmd = (cursor == 0) ? "complete" : "end";
            }
            
            // read the block and advance the cursor
            var blob = file.slice(start, stop);
            reader.readAsDataURL(blob);
            cursor++;
            
        }
        
        // open the file on the user's disk
        var reader = new FileReader();
        var startWithSequence = 0;
        
        // after each block is read, transfer it to the server
        var uploadBlock = function() {
            var kb = (cursor - startWithSequence) * blockSize / 1000;
            var sec = (new Date().getTime() - started.getTime()) / 1000;
            var overwrite = $("#file-overwrite").is(":checked");
            var add = (container) ? "&container=" + container : "";
            $.ajax({
                type: "POST",
                url: "/upload?name=" + file.name + "&cmd=" + cmd + "&seq=" + (cursor - 1) +  "&overwrite=" + overwrite + add,
                data: reader.result.match(/,(.*)$/)[1],
                success: function(response) {
                    if (response) {
                        switch (response.status) {
                            case "resume":
                                startWithSequence = response.sequence;
                                break;
                        }
                    }
                    switch (cmd) {
                        case "complete":
                        case "end":
                            filesLocal.splice(0, 1);
                            renderLocal();
                            file.ts = "now";
                            filesServer.unshift(file);
                            renderServer();
                            setTimeout(upload, 200); // upload the next file
                            $("#file-status").text("File (" + file.name + ") was successfully uploaded.");
                            break;
                        default:
                            file.status = Math.round(cursor / parts * 100) + "%, " + Math.round(kb / sec) + " KB/sec";
                            renderLocal();
                            read();
                            break;
                    }
                    retrySince = null;
                },
                error: function(xhr, status, error) {
                    var statusCode = (xhr.responseJSON) ? xhr.responseJSON.code : 0;
                    switch (statusCode) {
                        case 100:
                        case 110:
                        case 200:
                        case 300:
                        case 400:
                        case 500:
                            file.status = "Aborted.";
                            renderLocal();
                            $("#file-status").text(xhr.responseJSON.msg);
                            break;
                        default:
                            if (!retrySince) retrySince = new Date();
                            var elapsed = (new Date().getTime() - retrySince.getTime());
                            if (elapsed < retrySince) {
                                file.status = Math.round(cursor / parts * 100) + "%, retrying since " + retrySince.toLocaleTimeString();
                                renderLocal();
                                setTimeout(uploadBlock, 5000); // retry after 5 sec
                            } else {
                                file.status = "Aborted."
                                renderLocal();
                                $("#file-status").text("There was an error uploading " + file.name + ", even after multiple retries. Please try again later.");
                            }
                            break;
                    }
                }
            });
        }
        reader.onload = function(evt) {
            if (cursor >= startWithSequence) {
                uploadBlock();
            } else {
                read();
            }
        }
        
        // alert if there are any read errors
        reader.onerror = function(evt) {
            $("#file-status").text("There was an error reading the file. Please make sure the file is not locked.");
        }
        
        // read the first block
        read();

    }

}

$(document).ready(function() {
    
    // ensure the browser is HTML5
    if (window.File && window.FileReader && window.FileList && window.Blob) {

        // check for a login
        if (document.cookie.indexOf("accessToken") > -1) {

            // read the container if this is an admin window
            container = getQuerystring("container", null);

            // change the interface
            $("#file-login").hide();
            $("#file-interface").show();

            // refresh (to show server files)
            refresh();

        }

    } else {
        $("#file-status").text("You will need to use a fully HTML5 compatible browser.");
    }

});