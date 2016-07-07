
function create() {
    var username = $("#file-username").val();
    var password = $("#file-password").val();
    var container = $("#file-container").val();
    if (username && password && container) {
        $.ajax({
            type: "POST",
            url: "/account",
            contentType: "application/json",
            data: JSON.stringify({
                "username": username,
                "password": password,
                "container": container
            }),
            success: function(response) {
                refresh();
            },
            error: function(xhr, status, error) {
                $("#file-status").text("Could not create the account.");
            }
        });
    } else {
        $("#file-status").text("To create an account you must specify a valid, unique username, a password, and a container.");
    }
}

function refresh() {
    $("#file-account-list").html("");
    $.ajax({
        type: "GET",
        url: "/accounts",
        success: function(accounts) {
            $(accounts).each(function(i, account) {
                var tr = $("<tr />").appendTo("#file-account-list");
                $("<td />").appendTo(tr).text(account.username);
                $("<td />").appendTo(tr).text(account.password);
                var container = $("<td />").appendTo(tr);
                $("<a />").appendTo(container).text(account.container).attr({
                    "href": "/index.htm?container=" + account.container,
                    "target": "container." + account.container
                });
                var actions = $("<td />").appendTo(tr);
                $("<a>delete</a>").appendTo(actions).attr({
                    "href": "#"
                }).click(function() {
                    $.ajax({
                        type: "DELETE",
                        url: "/account?username=" + account.username,
                        success: function() {
                            $("#file-status").text(account.username + " deleted successfully.");
                            refresh();
                        },
                        error: function(xhr, status, error) {
                            $("#file-status").text("Could not delete, please try again later.");
                        }
                    });
                });
            });
        },
        error: function(xhr, status, error) {
            $("#file-status").text("Could not get a list of accounts from the server.");
        }
    });
}

function logout() {
    $.cookie("accessToken", null, { path: "/", expires: -1 });
    window.location.href = "/index.htm";
}

$(document).ready(function() {
    
    // ensure the browser is HTML5
    if (window.File && window.FileReader && window.FileList && window.Blob) {

        // check for a login
        //if (document.cookie.indexOf("accessToken") > -1) {

            // change the interface
            $("#file-interface").show();

            // refresh (to show server files)
            refresh();

        //}

    } else {
        $("#file-status").text("You will need to use a fully HTML5 compatible browser.");
    }

});