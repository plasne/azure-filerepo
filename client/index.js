
var blockSize = 200000; // in bytes
var retryFor = 30 * 60 * 1000 // in ms, current is 30 min
var filesLocal = [];
var filesServer = [];

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
        $("#upload").show();
    } else {
        $("#upload").hide();
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
        $("<td></td>").appendTo(tr).text(file.name);
        $("<td></td>").appendTo(tr).text(fileSize(file.size));
        $("<td></td>").appendTo(tr).text("?");
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
        
        // after each block is read, transfer it to the server
        var uploadBlock = function() {
            var kb = cursor * blockSize / 1000;
            var sec = (new Date().getTime() - started.getTime()) / 1000;
            var overwrite = $("#file-overwrite").is(":checked");
            $.ajax({
                type: "POST",
                url: "/upload?container=upload&name=" + file.name + "&cmd=" + cmd + "&seq=" + (cursor - 1) +  "&overwrite=" + overwrite,
                data: reader.result.match(/,(.*)$/)[1],
                success: function() {
                    switch (cmd) {
                        case "complete":
                        case "end":
                            filesLocal.splice(0, 1);
                            renderLocal();
                            filesServer.push(file);
                            renderServer();
                            setTimeout(upload, 200); // upload the next file
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
                    var response = xhr.responseJSON;
                    switch (response.code) {
                        case 000:
                        case 100:
                        case 200:
                        case 300:
                        case 400:
                            file.status = "Aborted.";
                            renderLocal();
                            $("#status").text(response.msg);
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
                                $("#status").text("There was an error uploading " + file.name + ", even after multiple retries. Please try again later.");
                            }
                            break;
                    }
                }
            });
        }
        reader.onload = function(evt) {
            uploadBlock();
        }
        
        // alert if there are any read errors
        reader.onerror = function(evt) {
            $("#status").text("There was an error reading the file. Please make sure the file is not locked.");
            $.ajax({
                type: "POST",
                url: "/upload?container=upload&name=" + file.name + "&cmd=abort"
            });
        }
        
        // read the first block
        read();

    }

}

$(document).ready(function() {
    
    // ensure the browser is HTML5
    if (window.File && window.FileReader && window.FileList && window.Blob) {
        $("#interface").show();
    } else {
        $("#status").text("You will need to use a fully HTML5 compatible browser.");
    }

    $("#file-hello").click(function() {
        $.ajax({
            type: "GET",
            url: "/hello"
        });
    });

});