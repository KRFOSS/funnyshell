class FunnyShell {
    constructor() {
        this.ws = null;
        this.username = '';
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        
        this.initializeElements();
        this.bindEvents();
        this.showLoginModal();
    }

    initializeElements() {
        this.terminal = document.getElementById('terminal');
        this.commandInput = document.getElementById('commandInput');
        this.chatMessages = document.getElementById('chatMessages');
        this.chatInput = document.getElementById('chatInput');
        this.sendChatBtn = document.getElementById('sendChat');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.userCount = document.getElementById('userCount');
        this.loginModal = document.getElementById('loginModal');
        this.usernameInput = document.getElementById('usernameInput');
        this.joinButton = document.getElementById('joinButton');
    }

    bindEvents() {
        // 명령어 입력
        this.commandInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && this.commandInput.value.trim()) {
                this.sendCommand(this.commandInput.value);
                this.commandInput.value = '';
            }
        });

        // 채팅 입력
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && this.chatInput.value.trim()) {
                this.sendChatMessage();
            }
        });

        this.sendChatBtn.addEventListener('click', () => {
            this.sendChatMessage();
        });

        // 로그인
        this.usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && this.usernameInput.value.trim()) {
                this.join();
            }
        });

        this.joinButton.addEventListener('click', () => {
            this.join();
        });

        // 페이지 언로드 시 연결 정리
        window.addEventListener('beforeunload', () => {
            this.stopHeartbeat();
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, 'Page unload');
            }
        });

        // 페이지 숨김/표시 이벤트 처리
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('페이지가 숨겨짐');
            } else {
                console.log('페이지가 다시 표시됨');
                // 페이지가 다시 표시될 때 연결 상태 확인
                if (this.ws && this.ws.readyState !== WebSocket.OPEN && this.isConnected) {
                    this.onDisconnect();
                }
            }
        });
    }

    showLoginModal() {
        this.loginModal.style.display = 'flex';
        this.usernameInput.focus();
    }

    hideLoginModal() {
        this.loginModal.style.display = 'none';
    }

    join() {
        const username = this.usernameInput.value.trim();
        if (!username) {
            alert('닉네임을 입력해주세요!');
            return;
        }

        if (username.length > 20) {
            alert('닉네임은 20자 이하로 입력해주세요!');
            return;
        }

        this.username = username;
        this.hideLoginModal();
        this.connect();
    }

    connect() {
        try {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?username=${encodeURIComponent(this.username)}`;
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.onConnect();
            };

            this.ws.onmessage = (event) => {
                this.onMessage(event);
            };

            this.ws.onclose = () => {
                this.onDisconnect();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket 오류:', error);
                this.addChatMessage('시스템', '연결 오류가 발생했습니다.', 'system');
            };

        } catch (error) {
            console.error('연결 시도 실패:', error);
            this.addChatMessage('시스템', '서버에 연결할 수 없습니다.', 'system');
        }
    }

    onConnect() {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.updateConnectionStatus(true);
        this.addChatMessage('시스템', `🎉 ${this.username}님, 환영합니다!`, 'system');
        this.commandInput.focus();
        
        // 터미널 초기화 - 환영 메시지 표시
        this.addTerminalOutput('\n🎮 ROKFOSS FunnyShell - 공유 터미널에 연결되었습니다!\n');
        this.addTerminalOutput('💡 명령어를 입력하고 Enter를 눌러 실행하세요.\n');
        
        // 주기적으로 연결 상태 확인
        this.startHeartbeat();
    }

    onDisconnect() {
        this.isConnected = false;
        this.updateConnectionStatus(false);
        this.addChatMessage('시스템', '❌ 연결이 끊어졌습니다.', 'system');
        
        // 하트비트 중지
        this.stopHeartbeat();
        
        // 자동 재연결 시도
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.addChatMessage('시스템', `🔄 재연결 시도 중... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'system');
            setTimeout(() => {
                this.connect();
            }, 2000);
        } else {
            this.addChatMessage('시스템', '❌ 재연결에 실패했습니다. 페이지를 새로고침해주세요.', 'system');
        }
    }

    startHeartbeat() {
        // 기존 하트비트가 있다면 정리
        this.stopHeartbeat();
        
        // 30초마다 연결 상태 확인
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    // ping 대신 간단한 연결 확인 메시지
                    this.ws.send(JSON.stringify({
                        type: 'ping',
                        data: 'heartbeat'
                    }));
                } catch (error) {
                    console.error('하트비트 전송 오류:', error);
                    this.onDisconnect();
                }
            } else if (this.ws && this.ws.readyState !== WebSocket.CONNECTING) {
                console.log('연결이 끊어짐을 감지');
                this.onDisconnect();
            }
        }, 30000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    onMessage(event) {
        try {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
                case 'output':
                    this.addTerminalOutput(message.data);
                    break;
                    
                case 'input_info':
                    this.addChatMessage('명령어', message.data, 'input');
                    break;
                    
                case 'system':
                    this.addChatMessage('시스템', message.data, 'system');
                    this.updateUserCount(message.data);
                    break;
                    
                case 'chat':
                    this.addChatMessage(message.user, message.data, 'chat');
                    break;
                    
                default:
                    console.log('알 수 없는 메시지 타입:', message.type);
            }
        } catch (error) {
            console.error('메시지 파싱 오류:', error);
        }
    }

    sendCommand(command) {
        if (!this.isConnected) {
            this.addChatMessage('시스템', '❌ 서버에 연결되지 않았습니다.', 'system');
            return;
        }

        // 명령어를 터미널에 먼저 표시 (에코)
        this.addTerminalOutput(`$ ${command}\n`);

        // 명령어에 개행문자 추가
        const fullCommand = command + '\n';
        
        const message = {
            type: 'input',
            data: fullCommand
        };

        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error('명령어 전송 오류:', error);
            this.addChatMessage('시스템', '❌ 명령어 전송에 실패했습니다.', 'system');
        }
    }

    sendChatMessage() {
        const message = this.chatInput.value.trim();
        if (!message) return;

        if (!this.isConnected) {
            this.addChatMessage('시스템', '❌ 서버에 연결되지 않았습니다.', 'system');
            return;
        }

        const chatMessage = {
            type: 'chat',
            data: message,
            user: this.username
        };

        try {
            this.ws.send(JSON.stringify(chatMessage));
            this.chatInput.value = '';
        } catch (error) {
            console.error('채팅 전송 오류:', error);
            this.addChatMessage('시스템', '❌ 채팅 전송에 실패했습니다.', 'system');
        }
    }

    addTerminalOutput(output) {
        // 빈 출력 체크
        if (!output) {
            return;
        }
        
        // 디버깅: 캐리지 리턴이 있는지 확인
        if (output.includes('\r')) {
            console.log('캐리지 리턴 감지:', JSON.stringify(output));
        }
        
        // 추가적인 ANSI 코드 정리 (캐리지 리턴과 개행은 보존)
        let cleanOutput = output
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // ANSI 이스케이프 시퀀스
            .replace(/\x1b\][0-9;]*[a-zA-Z]*/g, '') // OSC 시퀀스
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (match) => {
                // 개행(\n)과 캐리지 리턴(\r)은 보존
                if (match === '\n' || match === '\r') {
                    return match;
                }
                return '';
            })
            .replace(/\?2004[hl]/g, ''); // Bracketed paste mode
        
        // 캐리지 리턴 처리를 더 적극적으로
        this.processTerminalOutput(cleanOutput);
    }

    processTerminalOutput(output) {
        // \r\n을 \n으로 정규화
        output = output.replace(/\r\n/g, '\n');
        
        // \r로 분할해서 처리
        if (output.includes('\r')) {
            const segments = output.split('\r');
            console.log('캐리지 리턴 분할:', segments);
            
            // 첫 번째 세그먼트는 추가
            if (segments[0]) {
                this.appendTerminalOutput(segments[0]);
            }
            
            // 나머지 세그먼트들은 현재 줄을 덮어쓰기
            for (let i = 1; i < segments.length; i++) {
                const segment = segments[i];
                if (segment || i === segments.length - 1) {
                    this.replaceLastTerminalLine(segment);
                }
            }
        } else {
            // 캐리지 리턴이 포함된 출력 처리
            this.processTerminalOutput(output);
        }
    }

    appendTerminalOutput(output) {
        // HTML 특수문자 이스케이프
        const cleanOutput = this.escapeHtml(output);
        
        // 개행 문자로 분할
        const lines = cleanOutput.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            if (i === 0) {
                // 첫 번째 줄은 기존 마지막 줄에 추가하거나 새 줄 생성
                const lastOutput = this.terminal.lastElementChild;
                if (lastOutput && lastOutput.className === 'terminal-output' && !lastOutput.innerHTML.endsWith('<br>')) {
                    lastOutput.innerHTML += lines[i];
                } else {
                    const outputElement = document.createElement('div');
                    outputElement.className = 'terminal-output';
                    outputElement.innerHTML = lines[i] || '&nbsp;'; // 빈 줄은 공백으로
                    this.terminal.appendChild(outputElement);
                }
            } else {
                // 나머지 줄들은 새로운 div로 생성
                const outputElement = document.createElement('div');
                outputElement.className = 'terminal-output';
                outputElement.innerHTML = lines[i] || '&nbsp;'; // 빈 줄은 공백으로
                this.terminal.appendChild(outputElement);
            }
        }
        
        this.terminal.scrollTop = this.terminal.scrollHeight;
        this.trimTerminalHistory();
    }

    replaceLastTerminalLine(newContent) {
        // HTML 특수문자 이스케이프
        const cleanContent = this.escapeHtml(newContent);
        
        // 마지막 터미널 출력 요소 찾기
        let lastOutput = this.terminal.lastElementChild;
        
        // 마지막 요소가 터미널 출력이 아니라면 새로 생성
        if (!lastOutput || lastOutput.className !== 'terminal-output') {
            const outputElement = document.createElement('div');
            outputElement.className = 'terminal-output';
            outputElement.innerHTML = cleanContent || '&nbsp;';
            this.terminal.appendChild(outputElement);
        } else {
            // 기존 줄을 새 내용으로 교체
            lastOutput.innerHTML = cleanContent || '&nbsp;';
        }
        
        this.terminal.scrollTop = this.terminal.scrollHeight;
    }

    trimTerminalHistory() {
        // 터미널 내용이 너무 많으면 오래된 것들 제거
        if (this.terminal.children.length > 1000) {
            for (let i = 0; i < 100; i++) {
                if (this.terminal.firstChild) {
                    this.terminal.removeChild(this.terminal.firstChild);
                }
            }
        }
    }

    handleCarriageReturn(output) {
        // \r로 분할해서 처리
        const parts = output.split('\r');
        
        // 첫 번째 부분은 일반적으로 추가
        if (parts[0]) {
            let cleanOutput = this.escapeHtml(parts[0]).replace(/\n/g, '<br>');
            const outputElement = document.createElement('div');
            outputElement.className = 'terminal-output';
            outputElement.innerHTML = cleanOutput;
            this.terminal.appendChild(outputElement);
        }
        
        // 나머지 부분들은 마지막 줄을 덮어쓰기
        for (let i = 1; i < parts.length; i++) {
            if (parts[i]) {
                // 마지막 줄 찾기
                const lastOutput = this.terminal.lastElementChild;
                if (lastOutput && lastOutput.className === 'terminal-output') {
                    // 마지막 줄의 내용을 새로운 내용으로 교체
                    let cleanOutput = this.escapeHtml(parts[i]).replace(/\n/g, '<br>');
                    lastOutput.innerHTML = cleanOutput;
                } else {
                    // 마지막 줄이 없으면 새로 생성
                    let cleanOutput = this.escapeHtml(parts[i]).replace(/\n/g, '<br>');
                    const outputElement = document.createElement('div');
                    outputElement.className = 'terminal-output';
                    outputElement.innerHTML = cleanOutput;
                    this.terminal.appendChild(outputElement);
                }
            }
        }
        
        this.terminal.scrollTop = this.terminal.scrollHeight;
    }

    addChatMessage(sender, message, type = 'chat') {
        const messageElement = document.createElement('div');
        messageElement.className = `chat-message ${type}`;
        
        const timestamp = new Date().toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit'
        });
        
        if (type === 'system') {
            messageElement.innerHTML = `<small>${timestamp}</small><br>${this.escapeHtml(message)}`;
        } else if (type === 'input') {
            messageElement.innerHTML = `<small>${timestamp}</small><br>${this.escapeHtml(message)}`;
        } else {
            messageElement.innerHTML = `
                <strong>${this.escapeHtml(sender)}</strong> <small>${timestamp}</small><br>
                ${this.escapeHtml(message)}
            `;
        }
        
        this.chatMessages.appendChild(messageElement);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        
        // 메시지가 너무 많으면 오래된 것들 제거
        if (this.chatMessages.children.length > 100) {
            this.chatMessages.removeChild(this.chatMessages.firstChild);
        }
    }

    updateConnectionStatus(connected) {
        if (connected) {
            this.connectionStatus.textContent = '연결됨';
            this.connectionStatus.className = 'connected';
        } else {
            this.connectionStatus.textContent = '연결 끊김';
            this.connectionStatus.className = 'disconnected';
        }
    }

    updateUserCount(systemMessage) {
        // 시스템 메시지에서 사용자 수 추출
        const match = systemMessage.match(/총 (\d+)명 접속중/);
        if (match) {
            this.userCount.textContent = `${match[1]}명 접속중`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 페이지 로드 시 앱 시작
document.addEventListener('DOMContentLoaded', () => {
    new FunnyShell();
});

// 개발자 콘솔 메시지
console.log(`
🎮 ROKFOSS FunnyShell v1.0
👨‍💻 실시간 쉘 공유 시스템

⚠️  주의사항:
- 위험한 명령어 사용 금지
- 시스템 파일 수정 금지  
- 서로 배려하며 즐겁게 이용하세요!

🔧 개발: ROKFOSS Team
`);
