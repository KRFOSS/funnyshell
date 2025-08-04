package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type Message struct {
	Type string `json:"type"`
	Data string `json:"data"`
	User string `json:"user,omitempty"`
}

type Client struct {
	conn     *websocket.Conn
	send     chan Message
	username string
}

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan Message
	register   chan *Client
	unregister chan *Client
	ptyFile    *os.File
	cmd        *exec.Cmd
	mutex      sync.RWMutex
	lastOutput string // 마지막 출력을 저장해서 새 클라이언트에게 전송
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // CORS를 위해 모든 오리진 허용
	},
}

// ANSI 이스케이프 코드를 제거하는 정규식 (개행과 캐리지 리턴은 보존)
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\][0-9;]*[a-zA-Z]*`)

// ANSI 코드를 정리하는 함수
func cleanAnsiCodes(text string) string {
	// ANSI 이스케이프 시퀀스 제거
	cleaned := ansiRegex.ReplaceAllString(text, "")

	// 위험한 제어 문자들만 제거 (개행 \n과 캐리지 리턴 \r은 보존)
	result := ""
	for _, r := range cleaned {
		if r == '\n' || r == '\r' || r >= 32 || r == '\t' {
			result += string(r)
		}
	}

	return result
}

func newHub() *Hub {
	return &Hub{
		broadcast:  make(chan Message),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]bool),
	}
}

func (h *Hub) run() {
	// 쉘 시작
	h.startShell()

	// PTY에서 출력 읽기
	go h.readFromPty()

	for {
		select {
		case client := <-h.register:
			h.mutex.Lock()
			h.clients[client] = true
			h.mutex.Unlock()

			// 새 클라이언트에게 환영 메시지
			welcomeMsg := Message{
				Type: "system",
				Data: fmt.Sprintf("🎉 %s님이 참가했습니다! (총 %d명 접속중)", client.username, len(h.clients)),
			}
			h.broadcastToAll(welcomeMsg)

			// 새 클라이언트에게 현재 프롬프트 표시
			go func() {
				time.Sleep(500 * time.Millisecond)
				h.writeToShell("\n") // 새 프롬프트 표시
			}()

			log.Printf("클라이언트 등록: %s (총 %d명)", client.username, len(h.clients))

		case client := <-h.unregister:
			h.mutex.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)

				// 퇴장 메시지
				leaveMsg := Message{
					Type: "system",
					Data: fmt.Sprintf("👋 %s님이 나갔습니다. (총 %d명 접속중)", client.username, len(h.clients)),
				}
				h.broadcastToAll(leaveMsg)
			}
			h.mutex.Unlock()

			log.Printf("클라이언트 해제: %s (총 %d명)", client.username, len(h.clients))

		case message := <-h.broadcast:
			h.broadcastToAll(message)
		}
	}
}

func (h *Hub) broadcastToAll(message Message) {
	h.mutex.RLock()
	defer h.mutex.RUnlock()

	for client := range h.clients {
		select {
		case client.send <- message:
		default:
			close(client.send)
			delete(h.clients, client)
		}
	}
}

func (h *Hub) startShell() {
	// bash 실행
	cmd := exec.Command("bash", "--norc", "--noprofile")
	// 컬러 출력을 최소화하되 기본적인 터미널 기능은 유지
	env := os.Environ()
	newEnv := []string{}

	// 기존 환경변수 중 필요한 것들만 유지
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") ||
			strings.HasPrefix(e, "HOME=") ||
			strings.HasPrefix(e, "USER=") ||
			strings.HasPrefix(e, "PWD=") ||
			strings.HasPrefix(e, "LANG=") ||
			strings.HasPrefix(e, "LC_") {
			newEnv = append(newEnv, e)
		}
	}

	// 터미널 관련 환경변수 설정 - 더 기본적인 터미널로
	newEnv = append(newEnv,
		"TERM=vt100", // dumb 대신 vt100 사용 (캐리지 리턴 지원)
		"PS1=$ ",
		"PROMPT_COMMAND=",
		"LS_COLORS=",
		"GREP_COLOR=",
		"CLICOLOR=0",
		"DEBIAN_FRONTEND=noninteractive", // apt 등의 대화형 프롬프트 방지
	)

	cmd.Env = newEnv

	// PTY 생성
	ptyFile, err := pty.Start(cmd)
	if err != nil {
		log.Fatal("PTY 시작 실패:", err)
	}

	h.ptyFile = ptyFile
	h.cmd = cmd

	// 터미널 크기 설정
	h.setWinsize(80, 24)

	// 초기 명령어 전송 (프롬프트 표시를 위해)
	go func() {
		time.Sleep(200 * time.Millisecond)
		h.ptyFile.Write([]byte("clear\n"))
		time.Sleep(200 * time.Millisecond)
		h.ptyFile.Write([]byte("echo '🎮 ROKFOSS FunnyShell - 공유 터미널에 오신 것을 환영합니다!'\n"))
		time.Sleep(200 * time.Millisecond)
		h.ptyFile.Write([]byte("echo '💡 명령어를 입력하고 Enter를 눌러 실행하세요.'\n"))
	}()

	log.Println("쉘이 시작되었습니다.")
}

func (h *Hub) readFromPty() {
	buffer := make([]byte, 1024)
	for {
		n, err := h.ptyFile.Read(buffer)
		if err != nil {
			if err == io.EOF {
				log.Println("쉘이 종료되었습니다.")
				return
			}
			log.Printf("PTY 읽기 오류: %v", err)
			continue
		}

		output := string(buffer[:n])

		// 디버깅: 캐리지 리턴이 있는지 로그로 확인
		if strings.Contains(output, "\r") {
			log.Printf("캐리지 리턴 감지됨: %q", output)
		}

		// ANSI 코드 정리
		cleanedOutput := cleanAnsiCodes(output)

		// 완전히 빈 출력만 무시 (개행문자가 있는 것은 허용)
		if cleanedOutput == "" {
			continue
		}

		message := Message{
			Type: "output",
			Data: cleanedOutput,
		}

		h.broadcast <- message
	}
}

func (h *Hub) writeToShell(input string) {
	if h.ptyFile != nil {
		_, err := h.ptyFile.Write([]byte(input))
		if err != nil {
			log.Printf("쉘 입력 오류: %v", err)
		}
	}
}

func (h *Hub) setWinsize(cols, rows int) {
	if h.ptyFile == nil {
		return
	}

	ws := struct {
		Row uint16
		Col uint16
		X   uint16
		Y   uint16
	}{
		Row: uint16(rows),
		Col: uint16(cols),
	}

	syscall.Syscall(syscall.SYS_IOCTL, h.ptyFile.Fd(), uintptr(syscall.TIOCSWINSZ), uintptr(unsafe.Pointer(&ws)))
}

func (c *Client) readPump(hub *Hub) {
	defer func() {
		hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(512)
	c.conn.SetPongHandler(func(string) error {
		log.Printf("클라이언트 %s로부터 pong 수신", c.username)
		return nil
	})

	for {
		var msg Message
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("클라이언트 %s 웹소켓 연결 오류: %v", c.username, err)
			} else {
				log.Printf("클라이언트 %s 정상 연결 종료", c.username)
			}
			break
		}

		switch msg.Type {
		case "input":
			// 입력 명령을 쉘로 전송
			hub.writeToShell(msg.Data)

			// 다른 사용자들에게 누가 입력했는지 알림
			inputMsg := Message{
				Type: "input_info",
				Data: fmt.Sprintf("💻 %s: %s", c.username, strings.TrimSpace(msg.Data)),
				User: c.username,
			}
			hub.broadcast <- inputMsg

		case "chat":
			// 채팅 메시지 브로드캐스트
			chatMsg := Message{
				Type: "chat",
				Data: msg.Data,
				User: c.username,
			}
			hub.broadcast <- chatMsg

		case "ping":
			// 하트비트 응답 (로그 생략)
			continue

		case "resize":
			// 터미널 크기 조정 (간단히 80x24로 고정)
			hub.setWinsize(80, 24)
		}
	}
}

func (c *Client) writePump() {
	defer c.conn.Close()

	pingTicker := time.NewTicker(54 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteJSON(message); err != nil {
				log.Printf("클라이언트 %s 웹소켓 쓰기 오류: %v", c.username, err)
				return
			}

		case <-pingTicker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("클라이언트 %s ping 전송 실패: %v", c.username, err)
				return
			}
		}
	}
}

func handleWebSocket(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("웹소켓 업그레이드 오류: %v", err)
		return
	}

	// 사용자명 받기
	username := r.URL.Query().Get("username")
	if username == "" {
		username = fmt.Sprintf("익명%d", len(hub.clients)+1)
	}

	client := &Client{
		conn:     conn,
		send:     make(chan Message, 256),
		username: username,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump(hub)
}

func main() {
	hub := newHub()
	go hub.run()

	// 정적 파일 서빙을 위한 핸들러
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(hub, w, r)
	})

	// 웹 디렉토리 서빙
	http.Handle("/", http.FileServer(http.Dir("./web/")))

	port := ":8080"
	log.Printf("🚀 ROKFOSS FunnyShell 서버가 %s에서 시작되었습니다!", port)
	log.Println("📱 웹브라우저에서 http://localhost:8080 에 접속하세요!")

	err := http.ListenAndServe(port, nil)
	if err != nil {
		log.Fatal("서버 시작 실패:", err)
	}
}
