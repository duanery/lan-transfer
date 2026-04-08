# LAN File Transfer

A lightweight web-based file transfer tool for sharing files and folders between devices on the same local network.

## Features

- **File Upload** - Upload single or multiple files via button or drag-and-drop
- **Folder Upload** - Upload entire folders while preserving directory structure
- **Directory Browsing** - Navigate into folders, browse contents, download individual files
- **Breadcrumb Navigation** - Quickly jump back to any parent directory
- **Upload Progress** - Real-time progress bar during uploads
- **File Management** - Download and delete files; delete entire folders
- **QR Code** - Scan to quickly access from a mobile device
- **Custom Directory** - Specify a custom storage directory via command line
- **Responsive UI** - Works on desktop and mobile browsers

## Prerequisites

- [Node.js](https://nodejs.org/) v14 or later

## Installation

```bash
cd lan-transfer
npm install
```

## Usage

### Start with default storage directory (`./uploads`)

```bash
node server.js
```

### Start with a custom storage directory

```bash
node server.js /path/to/your/directory
```

### Example

```bash
node server.js ~/shared-files
```

On startup, the server prints the access URLs:

```
========================================
  LAN File Transfer Server
========================================
  Local:   http://localhost:3000
  LAN:     http://192.168.1.100:3000
  Dir:     /home/user/shared-files
========================================
```

Open the **LAN** address on any device connected to the same network to start transferring files.

## How It Works

1. Start the server on one computer.
2. Open the displayed LAN URL in a browser on any device in the same network.
3. **Upload**: Click "Select Files" / "Select Folder", or drag and drop files/folders onto the page.
4. **Browse**: Click a folder name to open it. Use the breadcrumb trail to navigate back.
5. **Download**: Click the "Download" button next to any file.
6. **Delete**: Click the "Delete" button to remove a file or folder.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files?dir=<path>` | List files and folders in a directory |
| `POST` | `/api/upload?dir=<path>` | Upload files (multipart form: `files[]` + `paths[]`) |
| `GET` | `/api/download/<path>` | Download a file |
| `DELETE` | `/api/files/<path>` | Delete a file or folder |
| `POST` | `/api/mkdir` | Create a new directory (JSON body: `{dir, name}`) |
| `GET` | `/api/qrcode` | Get server URL and QR code data URI |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| Port | `3000` | Hardcoded in `server.js` (edit `PORT` to change) |
| Max file size | `5 GB` | Per-file upload limit |
| Storage directory | `./uploads` | Override via command line argument |

## License

MIT
