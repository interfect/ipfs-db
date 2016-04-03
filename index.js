var express = require('express')

// Get some good file copying stuff
var fse = require('fs-extra')

// We want to stream JSON
var JSONStream = require('JSONStream')

// We want temp files
var temp = require('temp')

// And we need to work with paths
var path = require('path')

// We need to be able to parse form data
var bodyParser = require('body-parser')

// We need Mustache templates
var mustacheExpress = require('mustache-express')

// We have a database that lives in a JSON file

// Make a new Database int he given filename. It may need to start with a ./ if
// it's in the local directory and your temp directory is not on the same
// filesystem.
function Database(filename) {
    this.filename = filename;
    
    // Hold all the hashes, sorted by total votes
    this.databaseHashes = [];
    
    // Keep track of if we have been modified since load/save
    this.dirty = false;
}

// Load the database from disk and fire a callback when done
Database.prototype.load = function(callback) {
    var objStream = fse.createReadStream(this.filename).pipe(JSONStream.parse('*'))
    
    objStream.on('data', (hash_row) => {   
        // We got an object. Put it in the database.
        this.databaseHashes.push(hash_row)
    })
    
    objStream.on('end', () => {
        // We're done. Call the callback.
        
        this.dirty = false
        
        if(callback) callback()
    })
}

// Load a page from the database
Database.prototype.getPage = function(number, tag, callback) {
    var pageSize = 10
    
    if(!callback) {
        // 2 args is just number and callback
        callback = tag
        tag = undefined
    }
    
    // TODO: handle tag search
    if(tag) {
        // Manually get that page.
        
        var i = 0
        var found = 0
        
        var page = []
        
        while(i < this.databaseHashes.length && found < pageSize * number) {
            // Seek to that page
            if(this.databaseHashes[i].tags.indexOf(tag) != -1) {
                // This has that tag
                found++;
            }
            i++;
        }
        while(i < this.databaseHashes.length && page.length < pageSize) {
            // Find the page we want
            if(this.databaseHashes[i].tags.indexOf(tag) != -1) {
                // This has that tag
                page.push(this.databaseHashes[i])
            }
            i++;
        }
        
    } else {
    
        // What's the first thing to pull out?
        var start = (number + 1) * -pageSize
        // What's the last thing to pull out? Undefined if it would be -0
        var end = number * -pageSize || undefined
        
        // Slice out the page
        var page = this.databaseHashes.slice(start, end)
    }
    
    // Flip it in order of newest first
    page.reverse()
    
    // Call the callback.
    callback(page)
}

// Add a new hash to the database. Takes hash, type ("ipfs" or "ipns"), name
// (which may or may not be a filename), and tags (an array of strings).
Database.prototype.addHash = function(hash, type, name, tags, callback) {
    this.databaseHashes.push({
        hash: hash,
        type: type,
        name: name,
        tags: tags
    })
    
    this.dirty = true;
    
    return callback()
}

// Save the database back to disk. Call the callback when done. Changes between
// when this function is called and when the callback is called may or may not
// end up saved, and deletions or reorderings may result in some records being
// saved twice and others not at all.
Database.prototype.save = function(callback) {
    // Save to a temp file
    temp.open({dir: path.dirname(this.filename)}, (err, info) => {
        // OK we have a temp file
        if(err) throw err
        
        console.log("Opened temp file " + info.filename)
        
        // Make a stream to the file
        var outStream = fse.createWriteStream(null, {fd: info.fd})
        // We can't use JSONStream.stringify because it mishandles end events.
        
        // How many items have been saved?
        var i = 0
        
        var writeMore = () => {
            console.log("Writing data...")
            while(i < this.databaseHashes.length) {
                var keepGoing = outStream.write(JSON.stringify(this.databaseHashes[i]) + ",\n")
                i++
                if(!keepGoing) {
                    // We have no more room. Write more when the stream needs
                    // more data.
                    console.log("Stream full. Waiting.")
                    outStream.once('drain', writeMore)
                    return;
                }
            }
            
            // When we get here, the stream is drained and we have no more data.
            // TODO: end isn't calling finish. Just close things.
            
            // The stream is done. End has been called.
            
            console.log("Data written")
            
            // Finish the array
            outStream.end("]", () => {
                console.log("Array terminated")
                // Assume end closed the FD
                // Now atomically move the file
                
                console.log("Rename " + info.path + " to " + this.filename)
                
                fse.rename(info.path, this.filename, (err) => {
                    if(err) throw err
                    
                    console.log("Renamed " + info.path + " to " + this.filename)
                    
                    this.dirty = false
                    
                    // Now we're done! Tell the person who wanted the database
                    // saved.
                    if(callback) callback()
                })
            })
        }
        
        // Open an array
        outStream.write("[\n", () => {
            // Start the data writing process
            writeMore()
        })
        
    })
}

var app = express()

// Make a parser for POST data
var urlencodedParser = bodyParser.urlencoded({extended: false})

// Set up Mustache templating, because I know it from Ractive
app.engine('mustache', mustacheExpress());
app.set('view engine', 'mustache')
app.set('views', __dirname + '/views')

// Set up static files
app.use(express.static('public'))

// Homepage is just page 0
app.get('/', function(req, res) {
    console.log("Got a GET request for the homepage")
   
    // Grab the first page
    db.getPage(0, (hashes) => {
        // Pass along the page of hash records to the templating engine
        res.render('index', {
            site: "IPFS Hash Database",
            pageName: "Home",
            message: "Hello there!",
            hashes: hashes,
            nextPage: hashes.length == 10 ? '1' : false
        })
    })
})

// We can get pages
app.get('/:page', function(req, res) {
    
    var page = parseInt(req.params.page) || 0

    console.log("Got a GET request for page " + page)
   
    // Grab the page
    db.getPage(page, (hashes) => {
        // Pass along the page of hash records to the templating engine
        res.render('index', {
            site: "IPFS Hash Database",
            pageName: "Page " + (page + 1),
            hashes: hashes,
            prevPage: page > 0 ? (page - 1).toString() : false,
            nextPage: hashes.length == 10 ? (page + 1).toString() : false
        })
    })
})

// We can get tags
app.get('/tags/:tag/:page', function(req, res) {
    
    var tag = (req.params.tag || "").substring(0, 20).replace(/[^A-Za-z0-9]/g, '') || undefined
    var page = parseInt(req.params.page) || 0

    console.log("Got a GET request for tag " + tag + " page " + page)
   
    // Grab the page
    db.getPage(page, tag, (hashes) => {
        // Pass along the page of hash records to the templating engine
        res.render('index', {
            site: "IPFS Hash Database",
            pageName: "#" + tag + " page " + (page + 1),
            hashes: hashes,
            prevPage: page > 0 ? (page - 1).toString() : false,
            nextPage: hashes.length == 10 ? (page + 1).toString() : false
        })
    })
})


// You can post hashes to add them
app.post('/hash/add', urlencodedParser, function(req, res) {
    console.log("Got a POST request to add a hash")
   
    var process = (callback) => {
   
        // Get the hash
        var hash = req.body.hash;
        var hashRegex = /^(Qm[A-HJ-NP-Za-km-z1-9]{44,45})$/
        if(!hashRegex.test(hash)) {
            // This isn't a real hash
            return callback("Hash is invalid")
        }
        
        // Then get and check the name
        var name = req.body.name;
        if(typeof name != 'string') {
            return callback("Name is not a string")
        }
        if(name.length == 0) {
            return callback("Name is too short")
        }
        if(name.length > 100) {
            return callback("Name is too long")
        }
        
        // Then get and check the tags
        var tags = req.body.tags || ''
        tags = tags.split(",")
        if(tags.length > 10) {
            return callback("Too many tags")
        }
        fixedTags = []
        for(var i = 0; i < tags.length; i++) {
            tags[i] = tags[i].replace(/[^A-Za-z0-9]/g, '')
            if(tags[i].length == 0) {
                continue
            }
            if(tags[i].length > 20) {
                return callback("Tag too long")
            }
            fixedTags.push(tags[i])
        }
        // Deduplicate (see http://stackoverflow.com/a/23238595)
        fixedTags = fixedTags.filter(function(elem, pos) {
            return fixedTags.indexOf(elem) == pos
        })
        
        // Now put it in the database.
        db.addHash(hash, "ipfs", name, fixedTags, () => {
            // When it's in the database, call our callback with no error.
            callback();
        });
    }
    
    process((err) => {
        if(err) {
            // Complain they did something wrong
            res.send("Nope! " + err)
        } else {
            res.redirect("/")
        }
    })
})

// Load up a database
var db = new Database('database.json')
db.load(() => {

    var server = app.listen(8888, '::1', () => {

      var host = server.address().address
      var port = server.address().port

      console.log("Example app listening at http://[%s]:%s", host, port)

    })
    
    var server4 = app.listen(8888, '127.0.0.1', () => {

      var host = server4.address().address
      var port = server4.address().port

      console.log("Example app listening at http://%s:%s", host, port)

    })
    
})

// Periodically save the database to disk
var savePeriodically = () => {
    if(db.dirty) {
        console.log("Database is dirty. Saving...")
        db.save(() => {
            console.log("Database saved.")
            // Check again after we save
            setTimeout(savePeriodically, 5000)
        })
    } else {
        // Wait and check again
        setTimeout(savePeriodically, 5000)
    }
}
setTimeout(savePeriodically, 5000);
