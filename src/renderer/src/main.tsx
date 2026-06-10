import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// Sin StrictMode: su doble montaje en dev crearía dos PTYs por celda.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
