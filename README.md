## Improving performance
Depending on a variety of factors (network latency, time of day, etc.) transfer speeds appear to be somewhere between 600 MBps and 1500 MBps. I have some thoughts on how to improve performance:

* I have not done much testing on modifying the block size (I tested with 200K), but modifying this could have an impact.

* You could transmit multiple blocks to the server at the same time (ie. send them in parallel instead of a single serial transmission). You would need to buffer them when they come in out-of-order and have a failsafe whereby you stop transmission if a packet is missed.

* You could save the files to the local drive on the server and then have a separate thread to send them to Azure Blob Storage.

## Making operational
The following steps are considerations for making this sample operational for your company.

* If deploying to Azure App Service the configuration parameters (ex. config/default.json) will need to be included in the source control system (ex. private GitHub repo) or a different method will need to be used. The recommendation would be to use "App settings" instead.

* The interface should be modified to meet your company's standards for branding and usability.

* There should be some consideration and process for deleting files and/or containers after a period of time.

